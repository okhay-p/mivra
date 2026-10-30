import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/**
 * Serves the built web UI, if there is one, with the API token embedded in index.html.
 * The Host guard in createApp keeps other sites from reading the token.
 */
export function serveWeb(app: Hono<any, any, any>, webDist: string, token: string) {
  if (!existsSync(webDist)) return;
  const indexHtml = readFileSync(join(webDist, "index.html"), "utf8").replace(
    "</head>",
    `<meta name="mivra-token" content="${token}" /></head>`,
  );
  app.use("/assets/*", serveStatic({ root: webDist }));
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml)));
}
