import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";

// Each worker runs its own harness and database (see fixtures.ts), on ports from MIVRA_E2E_PORT upwards.
const workers = Number(process.env.MIVRA_E2E_WORKERS ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3))));

export default defineConfig({
  testDir: "tests",
  globalSetup: "./global-setup.ts",
  workers,
  // Tests are spread across workers one by one, so one long file doesn't hold up the rest.
  fullyParallel: true,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    // The graph's labels are positioned HTML over an SVG, so it's checked where engines differ on that.
    { name: "firefox", testMatch: "graph.spec.ts", use: devices["Desktop Firefox"] },
    { name: "webkit", testMatch: "graph.spec.ts", use: devices["Desktop Safari"] },
  ],
});
