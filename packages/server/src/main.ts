import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { createRegistry, resolveModel } from "./model.js";
import { createProviderCatalog } from "./models/catalog.js";
import { defaultSelectionFor } from "./models/selection.js";
import { createSettingsStore } from "./store/settings-store.js";
import { loadOrCreateToken } from "./security.js";
import { serveWeb } from "./serve-web.js";

const config = loadConfig();
const db = openDb(join(config.dataDir, "mivra.db"));
const token = loadOrCreateToken(config.dataDir);
const registry = createRegistry();
const settings = createSettingsStore(db);
// A provider shows in the picker only when its key is set (ADR-012).
const keys = { openrouter: process.env.OPENROUTER_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
const app = createApp({
  db,
  model: (selection) => resolveModel(selection.model, registry),
  models: {
    defaults: defaultSelectionFor(keys),
    catalog: createProviderCatalog({
      keys,
      baseUrls: { anthropic: process.env.ANTHROPIC_BASE_URL, openai: process.env.OPENAI_BASE_URL },
      // The last good lists survive restarts, so the picker works offline.
      persistFor: (source) => ({ load: () => settings.get(`catalog.${source}`), save: (models) => settings.set(`catalog.${source}`, models) }),
    }),
  },
  security: { token, allowedHosts: config.allowedHosts },
});

if (config.ignored.length > 0) {
  console.warn(`${config.ignored.join(" and ")} ${config.ignored.length > 1 ? "are" : "is"} no longer used: choose the model in the picker under the message box.`);
}

if (!keys.openrouter && !keys.anthropic && !keys.openai) {
  console.warn("No model provider key is set. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY or OPENAI_API_KEY) in .env; see .env.example.");
}

// In production the server also serves the built web UI (ADR-003). In dev, Vite serves it and proxies /api here.
serveWeb(app, fileURLToPath(new URL("../../web/dist", import.meta.url)), token);

// Bind to loopback only: remote access must be an explicit opt-in (ADR-001).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Mivra server listening on http://127.0.0.1:${info.port} (data: ${config.dataDir})`);
});
