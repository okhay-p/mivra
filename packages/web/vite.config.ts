import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  plugins: [react(), injectToken()],
  server: {
    // Loopback by default. To reach it from other devices, use `tailscale serve 5173` rather than
    // binding all interfaces; set MIVRA_DEV_HOST only if you understand the exposure.
    host: process.env.MIVRA_DEV_HOST ?? "127.0.0.1",
    allowedHosts: [".ts.net"],
    // changeOrigin makes proxied requests arrive with a loopback Host, which the server accepts.
    proxy: { "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true } },
  },
});
