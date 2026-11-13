import { parseArgs } from "node:util";
import { providerIds, type ProviderId } from "../../server/src/credentials.js";

export type Command =
  | { name: "start"; port?: number; open: boolean; detach: boolean }
  | { name: "stop" }
  | { name: "status" }
  | { name: "auth-set"; provider: ProviderId; check: boolean }
  | { name: "auth-status" }
  | { name: "auth-remove"; provider: ProviderId }
  | { name: "auth-login"; newAccount: boolean; open: boolean }
  | { name: "auth-logout" }
  | { name: "import-obsidian"; folder: string; importName?: string }
  | { name: "link"; course?: string; run?: string; runOutput?: string; server?: string; local: boolean }
  | { name: "token" }
  | { name: "check"; timeoutS: number }
  | { name: "uninstall"; deleteData: boolean | undefined }
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
  auth login chatgpt       Sign in with ChatGPT to use your Plus or Pro plan instead of a key
    --new-account          Sign in to a different account than last time
    --no-open              Print the sign-in address instead of opening the browser
  auth logout chatgpt      Sign out of ChatGPT
  import obsidian <folder> Import an Obsidian vault's notes into a running Mivra; run it again to re-import
    --name <name>          Name the import (default: the folder's name)
  link <course>            Link this folder to a project course, in .mivra.json (no secrets; safe to commit)
    --run <command>        How to run your program, e.g. "./build/mycc {input}": {input} becomes the path to a
                           file holding a case's input, which also comes on stdin. Runs without a shell
    --run-output <command> For cases that run your program's output (e.g. assembly): {output} is its path
  link --server <url>      Use the Mivra at this address (on another computer) for link and check. Asks for its
                           token (or pipe it in) and saves both in the data dir, never in .mivra.json
  link --local             Go back to the Mivra running on this computer
  token                    Print this Mivra's token, for \`mivra link --server\` on another computer
  check                    Run your program on the current milestone's cases and record the result in Mivra
    --timeout <seconds>    Time limit for each run (default: 10)
  uninstall                Stop Mivra and ask whether to delete its data, before you remove the package
    --delete-data          Delete the data without asking
    --keep-data            Keep the data without asking

Providers: ${providerIds.join(", ")}
Data lives in ~/.mivra, or MIVRA_DATA_DIR.`;

export class UsageError extends Error {}

/**
 * A remote Mivra's address for `--server`, as its origin: http(s) only, with nothing a token could leak through or
 * that Mivra wouldn't serve (a user name, a path, a query).
 */
export function serverUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UsageError(`--server needs an address such as https://mivra.example.ts.net, not "${input}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("--server needs an http:// or https:// address.");
  if (url.username || url.password) throw new UsageError("Leave the user name and password out of --server: Mivra asks for its token separately.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new UsageError(`--server takes the address Mivra opens at, without a path: ${url.origin}`);
  return url.origin;
}

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
        run: { type: "string" },
        "run-output": { type: "string" },
        server: { type: "string" },
        local: { type: "boolean", default: false },
        timeout: { type: "string" },
        detach: { type: "boolean", default: false },
        open: { type: "boolean", default: true },
        check: { type: "boolean", default: true },
        "new-account": { type: "boolean", default: false },
        "delete-data": { type: "boolean", default: false },
        "keep-data": { type: "boolean", default: false },
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
      if (sub === "login" || sub === "logout") {
        tooMany(3);
        if (arg !== undefined && arg !== "chatgpt") throw new UsageError(`Only ChatGPT has a sign-in: \`mivra auth ${sub} chatgpt\`. API keys use \`mivra auth set\`.`);
        return sub === "login" ? { name: "auth-login", newAccount: values["new-account"], open: values.open } : { name: "auth-logout" };
      }
      if (sub === "status") {
        tooMany(2);
        return { name: "auth-status" };
      }
      throw new UsageError(sub ? `Unknown auth command "${sub}". Use set, status, remove, login or logout.` : "Use `mivra auth set|status|remove|login|logout`.");
    case "import":
      if (sub !== "obsidian") throw new UsageError(sub ? `Unknown import source "${sub}". Use obsidian.` : "Use `mivra import obsidian <folder>`.");
      if (!arg) throw new UsageError("Give the vault's folder: `mivra import obsidian <folder>`.");
      tooMany(3);
      return { name: "import-obsidian", folder: arg, ...(values.name === undefined ? {} : { importName: values.name }) };
    case "link": {
      tooMany(2);
      const runOutput = values["run-output"]?.trim();
      const server = values.server === undefined ? undefined : serverUrl(values.server);
      if (server && values.local) throw new UsageError("Use --server or --local, not both.");
      if (!sub) {
        if (server || values.local) {
          if (values.run !== undefined || runOutput) throw new UsageError('Give the course\'s id with --run: `mivra link <course> --run "<command>"`.');
          return { name: "link", ...(server ? { server } : {}), local: values.local };
        }
        throw new UsageError('Give the course\'s id, as the milestone in Mivra shows it: `mivra link <course> --run "<command>"`.');
      }
      if (!values.run?.trim()) throw new UsageError('Say how to run your program with --run, e.g. `mivra link <course> --run "./build/mycc {input}"`.');
      return { name: "link", course: sub, run: values.run.trim(), ...(runOutput ? { runOutput } : {}), ...(server ? { server } : {}), local: values.local };
    }
    case "token":
      tooMany(1);
      return { name: "token" };
    case "check": {
      tooMany(1);
      let timeoutS = 10;
      if (values.timeout !== undefined) {
        timeoutS = Number(values.timeout);
        if (!Number.isFinite(timeoutS) || timeoutS < 1 || timeoutS > 600) throw new UsageError(`--timeout needs a number of seconds from 1 to 600, not "${values.timeout}".`);
      }
      return { name: "check", timeoutS };
    }
    case "uninstall":
      tooMany(1);
      if (values["delete-data"] && values["keep-data"]) throw new UsageError("Use --delete-data or --keep-data, not both.");
      return { name: "uninstall", deleteData: values["delete-data"] ? true : values["keep-data"] ? false : undefined };
    case "help":
      return { name: "help" };
    default:
      void rest;
      throw new UsageError(`Unknown command "${command}".`);
  }
}
