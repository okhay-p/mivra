import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Set by scripts/test-slot.mjs when several test runs share the machine; otherwise Vitest's default.
const maxWorkers = process.env.MIVRA_TEST_WORKERS ? Number(process.env.MIVRA_TEST_WORKERS) : undefined;

// Resolve workspace packages to their TypeScript source, as the server's tests do.
export default defineConfig({
  resolve: { conditions: ["@mivra/source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["@mivra/source", ...defaultServerConditions] } },
  test: { include: ["test/**/*.test.ts"], maxWorkers, globalSetup: ["test/global-setup.ts"], testTimeout: 60_000, hookTimeout: 120_000 },
});
