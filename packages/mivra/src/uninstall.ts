import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { CHATGPT_FILE, chatGptFileStore, createChatGptSession } from "../../server/src/chatgpt/session.js";
import { CREDENTIALS_FILE } from "../../server/src/credentials.js";
import { TOKEN_FILE } from "../../server/src/security.js";
import { LOG_FILE, STATE_FILE } from "./state.js";

const PACKAGE = "@okhay-p/mivra";

/**
 * Everything Mivra writes into its data folder. Only these are deleted, never the folder wholesale:
 * MIVRA_DATA_DIR can point at a folder that holds other things.
 */
const DATA_ENTRIES = ["mivra.db", "mivra.db-wal", "mivra.db-shm", "mivra.db-journal", "backups", CREDENTIALS_FILE, CHATGPT_FILE, TOKEN_FILE, STATE_FILE, LOG_FILE];

export interface UninstallOptions {
  dataDir: string;
  /** What the command line said about the data; undefined asks. */
  deleteData: boolean | undefined;
  /** Stops a running Mivra; resolves to 0 once none is running. */
  stop: () => Promise<number>;
  confirm: (question: string) => Promise<boolean>;
  out: (message: string) => void;
  err: (message: string) => void;
}

/**
 * Stops Mivra and, if the user agrees, deletes its data. The package itself is left for npm to remove: a
 * program can't reliably delete itself while running, and Mivra can't tell which package manager installed it.
 */
export async function uninstall({ dataDir, deleteData, stop, confirm, out, err }: UninstallOptions): Promise<number> {
  // A running Mivra would write its files back, so nothing is deleted until it has stopped.
  if ((await stop()) !== 0) {
    err("Nothing was deleted. Stop Mivra, then run `mivra uninstall` again.");
    return 1;
  }
  const present = DATA_ENTRIES.filter((name) => existsSync(join(dataDir, name)));
  if (present.length === 0) {
    out(`No Mivra data in ${dataDir}.`);
  } else {
    const agreed =
      deleteData ?? (await confirm(`Delete your Mivra data in ${dataDir}? That's your sessions, courses, imported notes, saved keys and backups, and it can't be undone. [y/N] `));
    if (agreed) {
      const removed = await deleteDataIn(dataDir, present, err);
      if (!removed) return 1;
      out(existsSync(dataDir) ? `Deleted Mivra's data. ${dataDir} still holds files Mivra didn't create, so it was left in place.` : `Deleted ${dataDir}.`);
    } else {
      out(`Kept your data in ${dataDir}. Installing Mivra again picks it up; delete the folder yourself when you no longer want it.`);
    }
  }
  out(`To remove the program, run:\n\n  npm uninstall -g ${PACKAGE}\n`);
  return 0;
}

async function deleteDataIn(dataDir: string, entries: string[], err: (message: string) => void): Promise<boolean> {
  // Sign out first, so the ChatGPT sign-in is revoked rather than only forgotten.
  try {
    const session = createChatGptSession({ store: chatGptFileStore(dataDir) });
    if (session.view().signedIn && !(await session.signOut()).revoked) {
      err("ChatGPT didn't confirm the sign-out. To be sure, disconnect Mivra in ChatGPT's settings.");
    }
  } catch {
    // An unreadable sign-in file is deleted below all the same.
  }
  try {
    for (const name of entries) rmSync(join(dataDir, name), { recursive: true, force: true });
  } catch (error) {
    err(`Couldn't delete everything in ${dataDir}: ${(error as Error).message}`);
    return false;
  }
  try {
    if (readdirSync(dataDir).length === 0) rmdirSync(dataDir);
  } catch {
    // The folder stays; the caller says so.
  }
  return true;
}
