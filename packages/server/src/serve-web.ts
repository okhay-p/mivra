import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { compress } from "hono/compress";

/**
 * Serves the built web UI, if there is one, with the API token embedded in index.html.
 * The Host guard in createApp keeps other sites from reading the token.
 *
 * Built assets have content hashes in their names, so a browser may keep them for good, and they're compressed:
 * over a slow link (a phone on a tailnet) the main script is about a third of its size gzipped. index.html carries
 * the token and is never cached.
 */
export function serveWeb(app: Hono<any, any, any>, webDist: string, token: string) {
  if (!existsSync(webDist)) return;
  const indexHtml = readFileSync(join(webDist, "index.html"), "utf8").replace(
    "</head>",
    `<meta name="mivra-token" content="${token}" /></head>`,
  );
  app.use("/assets/*", compress(), async (c, next) => {
    await next();
    if (c.res.status === 200) c.header("cache-control", "public, max-age=31536000, immutable");
  });
  app.use("/assets/*", serveStatic({ root: webDist }));
  // An asset from an older build is gone, not the page: answering with index.html would hand a script HTML.
  app.get("/assets/*", (c) => c.notFound());
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    c.header("cache-control", "no-store");
    return c.html(indexHtml);
  });
}
