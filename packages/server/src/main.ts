import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { createRegistry, resolveModel } from "./model.js";
import { createOpenRouterCatalog, type CatalogModel } from "./models/catalog.js";
import { createSettingsStore } from "./store/settings-store.js";
import { loadOrCreateToken } from "./security.js";
import { serveWeb } from "./serve-web.js";

const config = loadConfig();
const db = openDb(join(config.dataDir, "mivra.db"));
const token = loadOrCreateToken(config.dataDir);
const registry = createRegistry();
const settings = createSettingsStore(db);
const app = createApp({
  db,
  model: (selection) => resolveModel(selection.model, registry),
  models: {
    // The last good list survives restarts, so the picker works offline.
    catalog: createOpenRouterCatalog({
      persist: { load: () => settings.get("catalog.openrouter"), save: (models: CatalogModel[]) => settings.set("catalog.openrouter", models) },
    }),
  },
  security: { token, allowedHosts: config.allowedHosts },
});

if (config.ignored.length > 0) {
  console.warn(`${config.ignored.join(" and ")} ${config.ignored.length > 1 ? "are" : "is"} no longer used: choose the model in the picker under the message box.`);
}

// In production the server also serves the built web UI (ADR-003). In dev, Vite serves it and proxies /api here.
serveWeb(app, fileURLToPath(new URL("../../web/dist", import.meta.url)), token);

// Bind to loopback only: remote access must be an explicit opt-in (ADR-001).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Mivra server listening on http://127.0.0.1:${info.port} (data: ${config.dataDir})`);
});
