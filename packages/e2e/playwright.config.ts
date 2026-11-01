import { defineConfig, devices } from "@playwright/test";

// Override to run alongside another checkout.
const port = Number(process.env.MIVRA_E2E_PORT ?? 4198);

export default defineConfig({
  testDir: "tests",
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    // The graph's labels are positioned HTML over an SVG, so it's checked where engines differ on that.
    { name: "firefox", testMatch: "graph.spec.ts", use: devices["Desktop Firefox"] },
    { name: "webkit", testMatch: "graph.spec.ts", use: devices["Desktop Safari"] },
  ],
  webServer: {
    // The real server and built UI, with only the model replaced (see harness.ts).
    command: `pnpm --filter @mivra/web build && pnpm exec tsx --conditions=@mivra/source harness.ts ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
