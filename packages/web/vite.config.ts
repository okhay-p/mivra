import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.MIVRA_PORT ?? 4096);

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev only: listen on all interfaces so the UI is reachable over the tailnet.
    host: true,
    allowedHosts: [".ts.net"],
    proxy: { "/api": `http://127.0.0.1:${serverPort}` },
  },
});
