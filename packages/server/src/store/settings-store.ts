import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

/** App-wide settings as JSON values by key. Like the other stores, the only code here that talks to Drizzle (ADR-007). */
export function createSettingsStore(db: Db, clock: () => Date = () => new Date()) {
  return {
    get(key: string): unknown {
      return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value;
    },
    set(key: string, value: unknown) {
      const updatedAt = clock();
      db.insert(settings).values({ key, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
    },
    delete(key: string) {
      db.delete(settings).where(eq(settings.key, key)).run();
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
