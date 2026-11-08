import { parseArgs } from "node:util";
import { providerIds, type ProviderId } from "../../server/src/credentials.js";

export type Command =
  | { name: "start"; port?: number; open: boolean; detach: boolean }
  | { name: "stop" }
  | { name: "status" }
  | { name: "auth-set"; provider: ProviderId; check: boolean }
  | { name: "auth-status" }
  | { name: "auth-remove"; provider: ProviderId }
  | { name: "import-obsidian"; folder: string; importName?: string }
  | { name: "help" }
  | { name: "version" };

export const USAGE = `Usage: mivra [command] [options]

Commands:
  start                    Start Mivra and open it in the browser (the default)
    --port <n>             Use this port, and fail if it's taken (default: 4096, or the next free one)
    --detach               Run in the background; stop it with \`mivra stop\`
    --no-open              Don't open the browser
  stop                     Stop Mivra running in the background
  status                   Say whether Mivra is running, and where
  auth set <provider>      Save an API key (asks for it; or pipe it in)
    --no-check             Save without asking the provider whether the key works
  auth status              Show which providers have a key
  auth remove <provider>   Remove a saved key
  import obsidian <folder> Import an Obsidian vault's notes into a running Mivra; run it again to re-import
    --name <name>          Name the import (default: the folder's name)

Providers: ${providerIds.join(", ")}
Data lives in ~/.mivra, or MIVRA_DATA_DIR.`;

export class UsageError extends Error {}

const provider = (value: string | undefined): ProviderId => {
  if (!value) throw new UsageError(`Name a provider: ${providerIds.join(", ")}.`);
  if (!providerIds.includes(value as ProviderId)) throw new UsageError(`Unknown provider "${value}". Use one of: ${providerIds.join(", ")}.`);
  return value as ProviderId;
};

/** Reads the command line. Throws UsageError for anything it doesn't understand. */
export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        port: { type: "string" },
        name: { type: "string" },
        detach: { type: "boolean", default: false },
        open: { type: "boolean", default: true },
        check: { type: "boolean", default: true },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { name: "help" };
  if (values.version) return { name: "version" };
  const [command = "start", sub, arg, ...rest] = positionals;
  const tooMany = (n: number) => {
    if (positionals.length > n) throw new UsageError(`Unexpected "${positionals[n]}".`);
  };

  switch (command) {
    case "start": {
      tooMany(1);
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--port needs a port number from 1 to 65535, not "${values.port}".`);
      }
      return { name: "start", port, open: values.open, detach: values.detach };
    }
    case "stop":
    case "status":
      tooMany(1);
      return { name: command };
    case "auth":
      if (sub === "set") {
        tooMany(3);
        return { name: "auth-set", provider: provider(arg), check: values.check };
      }
      if (sub === "remove") {
        tooMany(3);
        return { name: "auth-remove", provider: provider(arg) };
      }
      if (sub === "status") {
        tooMany(2);
        return { name: "auth-status" };
      }
      throw new UsageError(sub ? `Unknown auth command "${sub}". Use set, status or remove.` : "Use `mivra auth set|status|remove`.");
    case "import":
      if (sub !== "obsidian") throw new UsageError(sub ? `Unknown import source "${sub}". Use obsidian.` : "Use `mivra import obsidian <folder>`.");
      if (!arg) throw new UsageError("Give the vault's folder: `mivra import obsidian <folder>`.");
      tooMany(3);
      return { name: "import-obsidian", folder: arg, ...(values.name === undefined ? {} : { importName: values.name }) };
    case "help":
      return { name: "help" };
    default:
      void rest;
      throw new UsageError(`Unknown command "${command}".`);
  }
}
