import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Where a running Mivra records itself, so `mivra stop`, `status` and a second start can find it. */
export const STATE_FILE = "mivra.pid";
export const LOG_FILE = "mivra.log";

const State = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), url: z.string(), startedAt: z.string() });
export type RunState = z.infer<typeof State>;

export function readState(dataDir: string): RunState | undefined {
  try {
    const parsed = State.safeParse(JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(dataDir: string, state: RunState) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, STATE_FILE);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Removes the state file only if it's still this process's, so a newer Mivra's record survives. */
export function clearState(dataDir: string, pid: number) {
  if (readState(dataDir)?.pid === pid) rmSync(join(dataDir, STATE_FILE), { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a Mivra server answers at this URL. Checks the recorded process really is Mivra, not a reused pid. */
export async function answers(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** The Mivra recorded as running, if its process is alive and it answers. A stale record is removed. */
export async function running(dataDir: string): Promise<RunState | undefined> {
  const state = readState(dataDir);
  if (!state) return undefined;
  if (isAlive(state.pid) && (await answers(state.url))) return state;
  if (!isAlive(state.pid)) rmSync(join(dataDir, STATE_FILE), { force: true });
  return undefined;
}
