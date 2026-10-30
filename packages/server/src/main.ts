import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { resolveModel } from "./model.js";
import { loadOrCreateToken } from "./security.js";
import { serveWeb } from "./serve-web.js";

const config = loadConfig();
const db = openDb(join(config.dataDir, "mivra.db"));
const token = loadOrCreateToken(config.dataDir);
const app = createApp({
  db,
  model: () => resolveModel(config.model),
  security: { token, allowedHosts: config.allowedHosts },
});

// In production the server also serves the built web UI (ADR-003). In dev, Vite serves it and proxies /api here.
serveWeb(app, fileURLToPath(new URL("../../web/dist", import.meta.url)), token);

// Bind to loopback only: remote access must be an explicit opt-in (ADR-001).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Mivra server listening on http://127.0.0.1:${info.port} (model: ${config.model}, data: ${config.dataDir})`);
});
