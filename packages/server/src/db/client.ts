import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "./schema.js";

const defaultMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Backups kept in `backups/` next to the database; older ones are deleted after a new one is made. */
export const KEEP_BACKUPS = 5;

/** The database was migrated by a newer Mivra than this one, which can't safely use it. */
export class NewerDatabaseError extends Error {
  constructor(path: string) {
    super(`${path} was last used by a newer version of Mivra. Update Mivra, or restore an older copy from the backups folder next to it.`);
  }
}

/**
 * When the database already holds data and migrations are pending, copies it to `backups/` first (ADR-013), so an
 * upgrade that goes wrong never costs the learner their history. Drizzle applies every migration newer than the
 * last one recorded, so that's what counts as pending. A database a newer Mivra migrated is refused instead.
 */
function backupBeforeMigrating(sqlite: Database.Database, path: string, migrationsFolder: string, clock: () => Date): string | undefined {
  const hasTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  // A new database has nothing to lose.
  if (!hasTable) return undefined;
  const last = sqlite.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { created_at: number | string } | undefined;
  if (!last) return undefined;
  const lastApplied = Number(last.created_at);
  const known = readMigrationFiles({ migrationsFolder });
  const newestKnown = Math.max(0, ...known.map((m) => m.folderMillis));
  if (lastApplied > newestKnown) throw new NewerDatabaseError(path);
  if (!known.some((m) => m.folderMillis > lastApplied)) return undefined;

  // Private from the start: the folder is 0700, so a copy is never readable by other users, even before its chmod.
  const dir = join(dirname(path), "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const name = basename(path, ".db");
  const target = join(dir, `${name}-${clock().toISOString().replace(/[:.]/g, "-")}.db`);
  // VACUUM INTO writes a consistent copy, WAL included, in one statement. If it fails, nothing is migrated.
  sqlite.prepare("VACUUM INTO ?").run(target);
  chmodSync(target, 0o600);

  // Only Mivra's own backups (exactly its timestamped names) are ever deleted, never the one just made, and never a
  // copy the learner put here. Names sort by time.
  const generated = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.db$`);
  const older = readdirSync(dir).filter((f) => generated.test(f) && f !== basename(target)).sort();
  for (const old of older.slice(0, Math.max(0, older.length - (KEEP_BACKUPS - 1)))) rmSync(join(dir, old), { force: true });
  return target;
}

export interface OpenDbOptions {
  /** Where the migrations are; a bundled build (the `@okhay-p/mivra` package) passes where it ships them. */
  migrationsFolder?: string;
  /** Told the backup's path when one is made before migrating. */
  onBackup?: (path: string) => void;
  clock?: () => Date;
}

/**
 * Opens (or creates) the SQLite database and applies pending migrations, backing it up first when it holds data
 * (ADR-013). Pass ":memory:" for tests.
 */
export function openDb(path: string, { migrationsFolder = defaultMigrations, onBackup, clock = () => new Date() }: OpenDbOptions = {}) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    if (path !== ":memory:") {
      const backup = backupBeforeMigrating(sqlite, path, migrationsFolder, clock);
      if (backup) onBackup?.(backup);
    }
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type Db = ReturnType<typeof openDb>;
