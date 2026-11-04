import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Locator, Page } from "@playwright/test";

/** The first port; worker N uses BASE_PORT + N. Override to run alongside another checkout. */
const BASE_PORT = Number(process.env.MIVRA_E2E_PORT ?? 4198);
const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Starts the harness (the real server and built UI with a scripted model) and waits for it to say it is listening.
 * Readiness comes from this child's own output, carrying an id made for this start, so a server someone else left on
 * the port can't be mistaken for it. A port that's taken makes the harness exit, which fails the start.
 */
async function startHarness(port: number, dataDir: string): Promise<ChildProcess> {
  const instance = randomUUID();
  // One process (tsx as a loader, not a launcher), in its own process group. Its stdin is a pipe this worker holds:
  // if the worker dies, the pipe closes and the harness stops.
  const child = spawn(process.execPath, ["--conditions=@mivra/source", "--import", "tsx", "harness.ts", String(port)], {
    cwd: here,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MIVRA_E2E_INSTANCE: instance, MIVRA_E2E_OWNED: "1", MIVRA_E2E_DATA_DIR: dataDir },
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

/** Whether any process is left in the harness's process group. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits up to `ms` for the process group to empty. */
async function groupGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Stops everything in the harness's process group, whether or not its first process is still running: SIGTERM lets
 * it shut down cleanly, and SIGKILL follows after 5 s.
 */
async function stopHarness(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      return; // Nothing left in the group.
    }
    if (await groupGone(pid, signal === "SIGTERM" ? 5_000 : 2_000)) return;
  }
}

/**
 * Each worker gets its own harness and database, because tests read and change server-wide state
 * (`/e2e/state`, `/e2e/release`) and would see each other's runs otherwise.
 */
export const test = base.extend<object, { harnessURL: string }>({
  harnessURL: [
    async ({}, use, workerInfo) => {
      const port = BASE_PORT + workerInfo.parallelIndex;
      // Made here, not by the harness, so it's removed even if the harness is killed before it can clean up.
      const dataDir = mkdtempSync(join(tmpdir(), "mivra-e2e-"));
      try {
        const harness = await startHarness(port, dataDir);
        try {
          await use(`http://127.0.0.1:${port}`);
        } finally {
          await stopHarness(harness);
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  baseURL: async ({ harnessURL }, use) => use(harnessURL),
});
