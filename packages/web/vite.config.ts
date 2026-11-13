import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";
import { forwardingHeaders } from "./dev-proxy.js";

const serverPort = Number(process.env.MIVRA_PORT ?? 4096);
const dataDir = process.env.MIVRA_DATA_DIR ?? join(homedir(), ".mivra");

/** Dev only: embed the server's API token in index.html, as the production server does. */
function injectToken(): Plugin {
  return {
    name: "mivra-inject-token",
    apply: "serve",
    transformIndexHtml() {
      let token: string;
      try {
        token = readFileSync(join(dataDir, "auth-token"), "utf8").trim();
      } catch {
        return []; // Server hasn't created it yet; the UI shows a reload hint.
      }
      return [{ tag: "meta", attrs: { name: "mivra-token", content: token }, injectTo: "head" }];
    },
  };
}

const pyodideDir = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
const pyodideVersion = (JSON.parse(readFileSync(join(pyodideDir, "package.json"), "utf8")) as { version: string }).version;
/** Just what running Python needs: no packages beyond the standard library. */
const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PYODIDE_TYPES: Record<string, string> = { ".mjs": "text/javascript", ".wasm": "application/wasm", ".zip": "application/zip", ".json": "application/json" };

/**
 * The CSP for exercise workers (ADR-016), as the server sends it (`EXERCISE_WORKER_CSP` in
 * packages/server/src/serve-web.ts): only Mivra's own scripts and WebAssembly, no strings run as code, and no
 * connections anywhere else.
 */
const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";

/**
 * In dev, Pyodide's files from node_modules at /assets/pyodide-<version>/, where python-exercise.worker.ts loads
 * them, and exercise workers with the CSP the server gives them in production. The build doesn't copy them: the
 * server serves the same files from its own `pyodide` dependency (serve-web.ts), so the package has one copy.
 */
function pyodideAssets(): Plugin {
  const base = `/assets/pyodide-${pyodideVersion}/`;
  return {
    name: "mivra-pyodide-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url.includes("worker_file") && /exercise\.worker/.test(url)) res.setHeader("Content-Security-Policy", WORKER_CSP);
        const file = url.startsWith(base) ? url.slice(base.length).split("?")[0]! : undefined;
        if (!file || !PYODIDE_FILES.includes(file)) return next();
        res.setHeader("Content-Type", PYODIDE_TYPES[extname(file)]!);
        res.end(readFileSync(join(pyodideDir, file)));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), injectToken(), pyodideAssets()],
  // Exercise workers get their own CSP from the server, found by this path.
  worker: {
    format: "es",
    rolldownOptions: {
      output: { entryFileNames: (chunk) => (/exercise\.worker/.test(chunk.name) ? "assets/exercise-workers/[name]-[hash].js" : "assets/[name]-[hash].js") },
    },
  },
  // Resolve workspace packages (e.g. @mivra/protocol) to their TypeScript source; no prebuild needed.
  resolve: {
    conditions: ["@mivra/source", ...defaultClientConditions],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Loopback by default. To reach it from other devices, use `tailscale serve 5173` rather than
    // binding all interfaces; set MIVRA_DEV_HOST only if you understand the exposure.
    host: process.env.MIVRA_DEV_HOST ?? "127.0.0.1",
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        // changeOrigin makes proxied requests arrive with a loopback Host, which the server accepts.
        changeOrigin: true,
        // That hides where a request came from, so say so for requests from elsewhere (see dev-proxy.ts).
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            for (const [name, value] of Object.entries(forwardingHeaders(req.headers.host, req.socket.remoteAddress))) proxyReq.setHeader(name, value);
          });
        },
      },
    },
  },
});
