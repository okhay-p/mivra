import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";

// Resolve workspace packages (e.g. @mivra/protocol) to their TypeScript source, as in dev.
export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["@mivra/source", ...defaultClientConditions],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
