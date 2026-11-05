import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Resolve workspace packages to their TypeScript source, as the server's tests do.
export default defineConfig({
  resolve: { conditions: ["@mivra/source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["@mivra/source", ...defaultServerConditions] } },
  test: { include: ["test/**/*.test.ts"], globalSetup: ["test/global-setup.ts"], testTimeout: 60_000, hookTimeout: 120_000 },
});
