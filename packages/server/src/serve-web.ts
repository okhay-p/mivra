import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { compress } from "hono/compress";

/**
 * The Content-Security-Policy for code exercise workers (ADR-016), which the web build puts under
 * /assets/exercise-workers/. Learner code runs in them, and Python can hand it JavaScript objects, so the worker itself
 * may load only Mivra's own scripts and WebAssembly, never run a string as code (which also rules out `import()`
 * of another site), and connect only to Mivra. A worker's CSP comes from its own script's response.
 */
export const EXERCISE_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";

/** Just what running Python needs: no packages beyond the standard library. */
const PYODIDE_FILES = new Set(["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]);

/**
 * Where python-exercise.worker.ts loads Pyodide from, and the directory holding those files: the server's own
 * `pyodide` dependency, which also runs reference checks, so the package carries one copy (ADR-016). The web
 * build pins the same version, and its worker asks for this versioned path.
 */
export function pyodideAssets(): { base: string; dir: string } {
  const packageJson = createRequire(import.meta.url).resolve("pyodide/package.json");
  const { version } = JSON.parse(readFileSync(packageJson, "utf8")) as { version: string };
  return { base: `/assets/pyodide-${version}/`, dir: dirname(packageJson) };
}

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
    if (c.req.path.startsWith("/assets/exercise-workers/")) c.header("content-security-policy", EXERCISE_WORKER_CSP);
  });
  const pyodide = pyodideAssets();
  const servePyodide = serveStatic({ root: pyodide.dir, rewriteRequestPath: (path) => path.slice(pyodide.base.length - 1) });
  app.use(`${pyodide.base}*`, async (c, next) => (PYODIDE_FILES.has(c.req.path.slice(pyodide.base.length)) ? servePyodide(c, next) : c.notFound()));
  app.use("/assets/*", serveStatic({ root: webDist }));
  // An asset from an older build is gone, not the page: answering with index.html would hand a script HTML.
  app.get("/assets/*", (c) => c.notFound());
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    c.header("cache-control", "no-store");
    return c.html(indexHtml);
  });
}
