import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The running Mivra's record and lock: created exclusively before the database opens, so only one Mivra runs per
 * data dir, and kept until it exits. `url` is set once the server listens.
 */
export const STATE_FILE = "mivra.pid";
export const LOG_FILE = "mivra.log";

/** A record without a URL older than this is from a start that died before listening. */
const STARTING_LIMIT_MS = 2 * 60 * 1000;

const State = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive().optional(),
  url: z.string().optional(),
  startedAt: z.string(),
});
export type RunState = z.infer<typeof State>;

const statePath = (dataDir: string) => join(dataDir, STATE_FILE);

export function readState(dataDir: string): RunState | undefined {
  try {
    const parsed = State.safeParse(JSON.parse(readFileSync(statePath(dataDir), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces this process's record (it already holds the lock). */
export function writeState(dataDir: string, state: RunState) {
  const path = statePath(dataDir);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/** Removes the record only if it's still this process's, so a newer Mivra's survives. */
export function clearState(dataDir: string, pid: number) {
  if (readState(dataDir)?.pid === pid) rmSync(statePath(dataDir), { force: true });
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

/** When this process claimed the data dir, to tell its own record from a previous run's with the same pid. */
let ownStart: string | undefined;

/** A record nobody holds any more: its process is gone, or it never got as far as listening. */
function isStale(state: RunState | undefined, now = Date.now()): boolean {
  if (!state) return true;
  if (!isAlive(state.pid)) return true;
  // Our own pid in a record we didn't write is a previous run's: in a container Mivra is always pid 1, so a container
  // killed without a clean stop leaves a record that names the next one.
  if (state.pid === process.pid && state.startedAt !== ownStart) return true;
  return !state.url && now - Date.parse(state.startedAt) > STARTING_LIMIT_MS;
}

/** The Mivra recorded as running, if its process is alive and it answers. A stale record is removed. */
export async function running(dataDir: string): Promise<(RunState & { url: string }) | undefined> {
  const state = readState(dataDir);
  if (!state) return undefined;
  if (state.url && isAlive(state.pid) && (await answers(state.url))) return { ...state, url: state.url };
  if (isStale(state)) removeIfUnchanged(dataDir, state);
  return undefined;
}

function removeIfUnchanged(dataDir: string, state: RunState) {
  const now = readState(dataDir);
  if (now && now.pid === state.pid && now.startedAt === state.startedAt) rmSync(statePath(dataDir), { force: true });
}

export type Claim = { ok: true } | { ok: false; holder: RunState };

/**
 * Claims the data dir for this process by creating the record exclusively. Two starts at once can't both win:
 * the loser gets the holder's record, to wait for it or report it. A stale record is cleared and claimed.
 */
export function claim(dataDir: string, pid = process.pid): Claim {
  mkdirSync(dataDir, { recursive: true });
  ownStart = new Date().toISOString();
  const record = `${JSON.stringify({ pid, startedAt: ownStart } satisfies RunState)}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(statePath(dataDir), "wx", 0o600);
      try {
        writeSync(fd, record);
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readState(dataDir);
    // An unreadable record is one being written this instant, or junk; give a writer a moment before judging it.
    if (holder && !isStale(holder)) return { ok: false, holder };
    if (holder) removeIfUnchanged(dataDir, holder);
    else if (attempt > 0) rmSync(statePath(dataDir), { force: true });
  }
  const holder = readState(dataDir);
  if (holder) return { ok: false, holder };
  throw new Error(`Couldn't claim ${statePath(dataDir)}. If Mivra isn't running, delete it.`);
}

/** Waits for the holder of the record to answer, as when another start is still coming up. */
export async function waitForHolder(dataDir: string, timeoutMs: number): Promise<RunState | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(dataDir);
    if (!state || isStale(state)) return undefined;
    if (state.url && (await answers(state.url))) return state;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}
