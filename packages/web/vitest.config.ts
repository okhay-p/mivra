import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";

// Set by scripts/test-slot.mjs when several test runs share the machine; otherwise Vitest's default.
const maxWorkers = process.env.MIVRA_TEST_WORKERS ? Number(process.env.MIVRA_TEST_WORKERS) : undefined;

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
    maxWorkers,
  },
});
