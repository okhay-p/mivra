import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_FILE, claim, readState } from "../src/state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mivra-state-"));
  dirs.push(dir);
  return dir;
};

describe("claiming the data dir", () => {
  it("takes over a record left by a previous run with this process's pid, as in a container killed without stopping", () => {
    const dir = dataDir();
    // In a container Mivra is always pid 1, so the dead run's record names the live one.
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ pid: process.pid, port: 4096, url: "http://127.0.0.1:4096", startedAt: "2026-11-05T00:00:00.000Z" }));
    expect(claim(dir)).toEqual({ ok: true });
    expect(readState(dir)?.startedAt).not.toBe("2026-11-05T00:00:00.000Z");
  });

  it("still yields to a live process that isn't this one", () => {
    const dir = dataDir();
    const holder = { pid: process.ppid, port: 4096, url: "http://127.0.0.1:4096", startedAt: new Date().toISOString() };
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(holder));
    expect(claim(dir)).toEqual({ ok: false, holder });
  });
});
