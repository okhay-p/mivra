import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { createCredentialStore, keysSignature, type ProviderKeys } from "./credentials.js";
import { openDb } from "./db/client.js";
import { createRegistry, resolveModel } from "./model.js";
import { createKeyedCatalog, createProviderCatalog } from "./models/catalog.js";
import { checkProviderKey } from "./models/key-check.js";
import { defaultSelectionFor } from "./models/selection.js";
import { loadOrCreateToken } from "./security.js";
import { serveWeb } from "./serve-web.js";
import { createSettingsStore } from "./store/settings-store.js";

/** How many ports after the first one to try when it's taken (ADR-013). */
export const PORT_ATTEMPTS = 20;

export interface StartOptions {
  config: Config;
  /** The built web UI. Missing is fine in dev, where Vite serves it. */
  webDist: string;
  /** Where the migrations are; defaults to the repo's `drizzle` folder. */
  migrationsFolder?: string;
  /** Try the following ports when the first is taken. Never used when MIVRA_PORT chose the port. */
  portFallback?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Thrown when no port could be had: the one asked for, or every port tried. */
export class PortInUseError extends Error {
  constructor(readonly first: number, readonly last: number) {
    super(first === last ? `Port ${first} is already in use.` : `Ports ${first} to ${last} are all in use.`);
  }
}

/** Listens on the first free port from `first` (only `first` when `attempts` is 1), on loopback only. */
export async function listenOnFreePort(server: Server, first: number, attempts: number): Promise<number> {
  for (let port = first; port < first + attempts; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        // Bind to loopback only: remote access must be an explicit opt-in (ADR-001).
        server.listen(port, "127.0.0.1");
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new PortInUseError(first, first + attempts - 1);
}

/** Opens the database and starts the server with the built UI (ADR-001, ADR-013). */
export async function startServer({ config, webDist, migrationsFolder, portFallback = false, env = process.env, log = console.warn }: StartOptions): Promise<RunningServer> {
  const db = openDb(join(config.dataDir, "mivra.db"), migrationsFolder);
  const token = loadOrCreateToken(config.dataDir);
  const settings = createSettingsStore(db);
  // Keys come from the environment or the credentials file, read fresh so a key saved in settings or with
  // `mivra auth` applies from the next run (ADR-013).
  const credentials = createCredentialStore({ dataDir: config.dataDir, env });
  const baseUrls = { anthropic: env.ANTHROPIC_BASE_URL, openai: env.OPENAI_BASE_URL };
  let registry: { signature: string; registry: ReturnType<typeof createRegistry> } | undefined;
  const registryFor = (keys: ProviderKeys) => {
    const signature = keysSignature(keys);
    if (registry?.signature !== signature) {
      registry = { signature, registry: createRegistry({ openrouterApiKey: keys.openrouter, anthropicApiKey: keys.anthropic, openaiApiKey: keys.openai }) };
    }
    return registry.registry;
  };
  const app = createApp({
    db,
    model: (selection) => resolveModel(selection.model, registryFor(credentials.keys())),
    models: {
      defaults: () => defaultSelectionFor(credentials.keys()),
      // A provider shows in the picker only when its key is set (ADR-012).
      catalog: createKeyedCatalog(credentials.keys, (keys) =>
        createProviderCatalog({
          keys,
          baseUrls,
          // The last good lists survive restarts, so the picker works offline.
          persistFor: (source) => ({ load: () => settings.get(`catalog.${source}`), save: (models) => settings.set(`catalog.${source}`, models) }),
        }),
      ),
    },
    providers: {
      credentials,
      check: (provider, key) => checkProviderKey(provider, key, { baseUrl: provider === "openrouter" ? undefined : baseUrls[provider] }),
    },
    security: { token, allowedHosts: config.allowedHosts },
  });

  if (config.ignored.length > 0) {
    log(`${config.ignored.join(" and ")} ${config.ignored.length > 1 ? "are" : "is"} no longer used: choose the model in the picker under the message box.`);
  }
  if (Object.keys(credentials.keys()).length === 0) {
    log("No model provider key is set yet. Add one in Mivra under Model providers, run `mivra auth set openrouter`, or set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  }

  // The server also serves the built web UI (ADR-003). In dev, Vite serves it and proxies /api here.
  serveWeb(app, webDist, token);

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const port = await listenOnFreePort(server, config.port, portFallback && !config.portExplicit ? PORT_ATTEMPTS : 1);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Open streams (SSE) would hold close() until they end; a stop shouldn't wait on a reply.
        server.closeAllConnections?.();
      }),
  };
}
