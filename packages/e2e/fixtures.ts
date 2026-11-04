import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Locator, Page } from "@playwright/test";

/** The first port; worker N uses BASE_PORT + N. Override to run alongside another checkout. */
const BASE_PORT = Number(process.env.MIVRA_E2E_PORT ?? 4198);
const here = fileURLToPath(new URL(".", import.meta.url));
const tsx = fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", import.meta.url));

/**
 * Starts the harness (the real server and built UI with a scripted model) and waits for it to say it is listening.
 * Readiness comes from this child's own output, carrying an id made for this start, so a server someone else left on
 * the port can't be mistaken for it. A port that's taken makes the harness exit, which fails the start.
 */
async function startHarness(port: number): Promise<ChildProcess> {
  const instance = randomUUID();
  // Its own process group, so stopping it also stops the process tsx starts for the script. The harness also stops
  // itself if this worker dies without stopping it (MIVRA_E2E_OWNER_PID).
  const child = spawn(process.execPath, [tsx, "--conditions=@mivra/source", "harness.ts", String(port)], {
    cwd: here,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MIVRA_E2E_INSTANCE: instance, MIVRA_E2E_OWNER_PID: String(process.pid) },
  });
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`didn't start within 60 s`)), 60_000);
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes(`mivra-e2e-ready ${instance}\n`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`exited before it was ready (${signal ?? `code ${code}`})`));
      });
    });
  } catch (error) {
    await stopHarness(child);
    throw new Error(`The e2e harness on port ${port} ${(error as Error).message}: ${stderr.trim()}`);
  }
  return child;
}

/** SIGTERM lets the harness delete its data directory; SIGKILL follows if it hangs. */
async function stopHarness(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 5_000);
  await exited;
  clearTimeout(timer);
}

/**
 * Each worker gets its own harness and database, because tests read and change server-wide state
 * (`/e2e/state`, `/e2e/release`) and would see each other's runs otherwise.
 */
export const test = base.extend<object, { harnessURL: string }>({
  harnessURL: [
    async ({}, use, workerInfo) => {
      const port = BASE_PORT + workerInfo.parallelIndex;
      const harness = await startHarness(port);
      try {
        await use(`http://127.0.0.1:${port}`);
      } finally {
        await stopHarness(harness);
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  baseURL: async ({ harnessURL }, use) => use(harnessURL),
});
