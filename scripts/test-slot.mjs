#!/usr/bin/env node
// Runs a test command in one of a few machine-wide slots, so test runs from several worktrees take turns instead of
// starving each other of CPU, which made timing-sensitive tests time out. A slot is a loopback port this process
// listens on: the OS frees it however the process ends, so a crashed run never leaves a slot taken.
//
//   MIVRA_TEST_SLOTS      how many runs at once (default 1; 0 turns the wait off)
//   MIVRA_TEST_SLOT_PORT  the first slot's port (default 4180; slot n is that plus n)
//
// With more than one slot, each run gets its share of the CPUs: MIVRA_TEST_WORKERS (Vitest) and MIVRA_E2E_WORKERS
// (Playwright) are set to that share unless already set.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";

const intEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} must be a whole number, not "${raw}".`);
    process.exit(2);
  }
  return value;
};

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/test-slot.mjs <command> [args...]");
  process.exit(2);
}
const slots = intEnv("MIVRA_TEST_SLOTS", 1);
const base = intEnv("MIVRA_TEST_SLOT_PORT", 4180);

/** Listens on the port if it's free; resolves to the server holding it, or undefined if it's taken. */
const hold = (port) =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end("mivra test slot\n"));
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error)));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(server));
  });

async function acquire() {
  let waiting = false;
  for (;;) {
    for (let n = 0; n < slots; n++) {
      const server = await hold(base + n);
      if (server) {
        server.unref();
        if (waiting) console.error(`[test-slot] Got slot ${n + 1} of ${slots}.`);
        return server;
      }
    }
    if (!waiting) {
      waiting = true;
      const ports = slots === 1 ? `port ${base}` : `ports ${base}-${base + slots - 1}`;
      console.error(`[test-slot] Waiting for another test run to finish (${slots} at a time, on ${ports}; set MIVRA_TEST_SLOTS to change).`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const env = { ...process.env };
// A command run inside a slot already has one: a nested gated script mustn't wait for itself.
if (slots > 0 && env.MIVRA_TEST_SLOT_HELD !== "1") {
  await acquire();
  env.MIVRA_TEST_SLOT_HELD = "1";
  if (slots > 1) {
    const cpus = availableParallelism();
    env.MIVRA_TEST_WORKERS ??= String(Math.max(1, Math.floor(cpus / slots)));
    // Playwright's own default (packages/e2e/playwright.config.ts), shared the same way.
    env.MIVRA_E2E_WORKERS ??= String(Math.max(1, Math.floor(Math.min(4, Math.floor(cpus / 3)) / slots)));
  }
}

// In its own process group, so a signal reaches everything the command started (pnpm, Vitest and their workers),
// not just its first process; the slot stays held until the command itself exits.
const windows = process.platform === "win32";
const child = spawn(command, args, { stdio: "inherit", env, shell: windows, detached: !windows });
const forward = (signal) => {
  try {
    if (windows) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => forward(signal));
child.once("error", (error) => {
  console.error(`[test-slot] Couldn't run ${command}: ${error.message}`);
  process.exit(1);
});
/** Whether anything in the command's process group is still running, such as Vitest finishing after a signal. */
const groupAlive = () => {
  if (windows) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
child.once("exit", async (code, signal) => {
  // Keep the slot until the whole group has gone, so a cancelled run never overlaps the next one (up to 15 s).
  const deadline = Date.now() + 15_000;
  while (groupAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  process.exit(code ?? (signal ? 1 : 0));
});
