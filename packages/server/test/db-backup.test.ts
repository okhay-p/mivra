import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { KEEP_BACKUPS, NewerDatabaseError, openDb } from "../src/db/client.js";

const allMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(join(allMigrations, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mivra-backup-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The migrations an older Mivra shipped: the first `count` of today's. */
function olderMigrations(count: number): string {
  const dir = tempDir();
  mkdirSync(join(dir, "meta"));
  const entries = journal.entries.slice(0, count);
  for (const { tag } of entries) cpSync(join(allMigrations, `${tag}.sql`), join(dir, `${tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 5, 12, 0, tick++));
const backupsIn = (dataDir: string) => (existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).sort() : []);

/** A database made by an older Mivra, holding one session. */
function oldDatabase(dataDir: string, count = journal.entries.length - 1) {
  const path = join(dataDir, "mivra.db");
  const db = openDb(path, { migrationsFolder: olderMigrations(count), clock });
  db.$client.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Limits', 0, 0)").run();
  db.$client.close();
  return path;
}

describe("opening the database", () => {
  it("makes no backup for a new database", () => {
    const dataDir = tempDir();
    const backups: string[] = [];
    openDb(join(dataDir, "mivra.db"), { onBackup: (p) => backups.push(p), clock }).$client.close();
    expect(backups).toEqual([]);
    expect(backupsIn(dataDir)).toEqual([]);
  });

  it("backs up an existing database before applying new migrations", () => {
    const dataDir = tempDir();
    const path = oldDatabase(dataDir);
    const backups: string[] = [];
    const db = openDb(path, { onBackup: (p) => backups.push(p), clock });
    db.$client.close();

    expect(backups).toHaveLength(1);
    expect(backups[0]).toBe(join(dataDir, "backups", backupsIn(dataDir)[0]!));
    // The copy is the database as it was: the old migrations only, with the learner's data.
    const copy = new Database(backups[0]!, { readonly: true });
    expect(copy.prepare("SELECT title FROM sessions").all()).toEqual([{ title: "Limits" }]);
    expect((copy.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(journal.entries.length - 1);
    copy.close();
  });

  it("makes no backup when nothing is pending", () => {
    const dataDir = tempDir();
    const path = join(dataDir, "mivra.db");
    openDb(path, { clock }).$client.close();
    openDb(path, { clock }).$client.close();
    expect(backupsIn(dataDir)).toEqual([]);
  });

  it(`keeps the newest ${KEEP_BACKUPS} backups`, () => {
    const dataDir = tempDir();
    const path = join(dataDir, "mivra.db");
    for (let count = 1; count <= journal.entries.length; count++) openDb(path, { migrationsFolder: olderMigrations(count), clock }).$client.close();
    const kept = backupsIn(dataDir);
    expect(journal.entries.length - 1).toBeGreaterThan(KEEP_BACKUPS);
    expect(kept).toHaveLength(KEEP_BACKUPS);
    // Timestamps sort in order, so the oldest went first.
    expect(kept).toEqual([...kept].sort());
  });

  it("keeps the new backup even when older ones are dated later", () => {
    const dataDir = tempDir();
    const path = oldDatabase(dataDir);
    // Backups from a clock that ran ahead, or restored from another machine.
    mkdirSync(join(dataDir, "backups"));
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) writeFileSync(join(dataDir, "backups", `mivra-2099-01-01T00-00-0${i}-000Z.db`), "");
    const backups: string[] = [];
    openDb(path, { onBackup: (p) => backups.push(p), clock }).$client.close();
    expect(existsSync(backups[0]!)).toBe(true);
    expect(backupsIn(dataDir)).toHaveLength(KEEP_BACKUPS);
  });

  it("never deletes a copy the learner put in the backups folder", () => {
    const dataDir = tempDir();
    const path = join(dataDir, "mivra.db");
    mkdirSync(join(dataDir, "backups"));
    const mine = ["mivra-2020-manual.db", "mivra-before-exam.db", "notes.txt"];
    for (const f of mine) writeFileSync(join(dataDir, "backups", f), "mine");
    for (let count = 1; count <= journal.entries.length; count++) openDb(path, { migrationsFolder: olderMigrations(count), clock }).$client.close();
    for (const f of mine) expect(readFileSync(join(dataDir, "backups", f), "utf8")).toBe("mine");
    expect(backupsIn(dataDir).filter((f) => !mine.includes(f))).toHaveLength(KEEP_BACKUPS);
  });

  it("keeps backups private", () => {
    const dataDir = tempDir();
    const backups: string[] = [];
    openDb(oldDatabase(dataDir), { onBackup: (p) => backups.push(p), clock }).$client.close();
    expect(statSync(join(dataDir, "backups")).mode & 0o777).toBe(0o700);
    expect(statSync(backups[0]!).mode & 0o777).toBe(0o600);
  });

  it("refuses a database a newer Mivra migrated, and leaves it untouched", () => {
    const dataDir = tempDir();
    const path = join(dataDir, "mivra.db");
    openDb(path, { clock }).$client.close();
    expect(() => openDb(path, { migrationsFolder: olderMigrations(3), clock })).toThrow(NewerDatabaseError);
    expect(backupsIn(dataDir)).toEqual([]);
    const db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(journal.entries.length);
    db.close();
  });

  it("migrates nothing when the backup can't be written", () => {
    const dataDir = tempDir();
    const path = oldDatabase(dataDir);
    // A file where the backups folder should be.
    writeFileSync(join(dataDir, "backups"), "");
    expect(() => openDb(path, { clock })).toThrow();
    const db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(journal.entries.length - 1);
    db.close();
  });
});
