import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { resolveModel } from "./model.js";
import { loadOrCreateToken } from "./security.js";

const config = loadConfig();
const db = openDb(join(config.dataDir, "mivra.db"));
const token = loadOrCreateToken(config.dataDir);
const app = createApp({
  db,
  model: () => resolveModel(config.model),
  security: { token, allowedHosts: config.allowedHosts },
});

// In production the server also serves the built web UI (ADR-003). In dev, Vite serves it and proxies /api here.
// index.html carries the API token; the Host guard in createApp keeps other sites from reading it.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  const indexHtml = readFileSync(join(webDist, "index.html"), "utf8").replace(
    "</head>",
    `<meta name="mivra-token" content="${token}" /></head>`,
  );
  app.use("/assets/*", serveStatic({ root: webDist }));
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml)));
}

// Bind to loopback only: remote access must be an explicit opt-in (ADR-001).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Mivra server listening on http://127.0.0.1:${info.port} (model: ${config.model}, data: ${config.dataDir})`);
});
