import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Set by scripts/test-slot.mjs when several test runs share the machine; otherwise Vitest's default.
const maxWorkers = process.env.MIVRA_TEST_WORKERS ? Number(process.env.MIVRA_TEST_WORKERS) : undefined;

// Resolve workspace packages (e.g. @mivra/protocol) to their TypeScript source, as tsx does in dev.
// Setting conditions replaces Vite's defaults, so keep them.
export default defineConfig({
  resolve: { conditions: ["@mivra/source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["@mivra/source", ...defaultServerConditions] } },
  test: { include: ["test/**/*.test.ts"], maxWorkers },
});
