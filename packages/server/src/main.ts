import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createCredentialStore, keysSignature, type ProviderKeys } from "./credentials.js";
import { openDb } from "./db/client.js";
import { createRegistry, resolveModel } from "./model.js";
import { createKeyedCatalog, createProviderCatalog } from "./models/catalog.js";
import { checkProviderKey } from "./models/key-check.js";
import { defaultSelectionFor } from "./models/selection.js";
import { createSettingsStore } from "./store/settings-store.js";
import { loadOrCreateToken } from "./security.js";
import { serveWeb } from "./serve-web.js";

const config = loadConfig();
const db = openDb(join(config.dataDir, "mivra.db"));
const token = loadOrCreateToken(config.dataDir);
const settings = createSettingsStore(db);
// Keys come from the environment or the credentials file, read fresh so a key saved in settings or with
// `mivra auth` applies from the next run (ADR-013).
const credentials = createCredentialStore({ dataDir: config.dataDir });
const baseUrls = { anthropic: process.env.ANTHROPIC_BASE_URL, openai: process.env.OPENAI_BASE_URL };
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
  console.warn(`${config.ignored.join(" and ")} ${config.ignored.length > 1 ? "are" : "is"} no longer used: choose the model in the picker under the message box.`);
}

if (Object.keys(credentials.keys()).length === 0) {
  console.warn("No model provider key is set yet. Add one in Mivra under Settings → Model providers, or set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY or OPENAI_API_KEY).");
}

// In production the server also serves the built web UI (ADR-003). In dev, Vite serves it and proxies /api here.
serveWeb(app, fileURLToPath(new URL("../../web/dist", import.meta.url)), token);

// Bind to loopback only: remote access must be an explicit opt-in (ADR-001).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Mivra server listening on http://127.0.0.1:${info.port} (data: ${config.dataDir})`);
});
