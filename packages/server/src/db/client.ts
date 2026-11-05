import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

const defaultMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Opens (or creates) the SQLite database and applies pending migrations. Pass ":memory:" for tests. A bundled
 * build (the `mivra` package) passes where it ships the migrations.
 */
export function openDb(path: string, migrationsFolder = defaultMigrations) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof openDb>;
