import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../../server/src/config.js";
import { ApiKey, CREDENTIALS_FILE, PROVIDER_ENV, PROVIDER_LABELS, createCredentialStore, type ProviderId } from "../../server/src/credentials.js";
import { checkProviderKey } from "../../server/src/models/key-check.js";
import { NewerDatabaseError } from "../../server/src/db/client.js";
import { PortInUseError, startServer } from "../../server/src/start.js";
import { USAGE, UsageError, parseCommand, type Command } from "./args.js";
import { LOG_FILE, STATE_FILE, claim, clearState, isAlive, readState, running, waitForHolder, writeState } from "./state.js";
import { openBrowser, readSecret } from "./terminal.js";

/** The package root: dist/ or src/ sits one level below it. */
const root = fileURLToPath(new URL("..", import.meta.url));
/** Installed, the UI and migrations ship in the package; from the repo, they're the workspace's. */
const firstExisting = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? paths[0]!;
const webDist = () => firstExisting(join(root, "web"), join(root, "../web/dist"));
const migrations = () => firstExisting(join(root, "drizzle"), join(root, "../server/drizzle"));

const version = () => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

const out = (message: string) => process.stdout.write(`${message}\n`);
const err = (message: string) => process.stderr.write(`${message}\n`);

const DOCKER_HINT = "Mivra's database library has no prebuilt binary for this system. Run Mivra with Docker instead: see https://github.com/okhay-p/mivra#readme";

/** better-sqlite3 failing to load its native binary (an unsupported platform, or glibc older than 2.34). */
const isNativeLoadError = (error: unknown) => {
  const e = error as NodeJS.ErrnoException;
  return e?.code === "ERR_DLOPEN_FAILED" || /better[_-]sqlite3|bindings file|GLIBC_/i.test(String(e?.message));
};

/** Runs one command; resolves to the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const config = loadConfig(env);
  switch (command.name) {
    case "help":
      out(USAGE);
      return 0;
    case "version":
      out(version());
      return 0;
    case "start":
      return command.detach ? startDetached(command, config, env) : startForeground(command, config, env);
    case "stop":
      return stop(config.dataDir);
    case "status": {
      const state = await running(config.dataDir);
      out(state ? `Mivra is running at ${state.url} (process ${state.pid}).` : "Mivra isn't running.");
      return 0;
    }
    case "auth-set":
      return authSet(command.provider, command.check, config, env);
    case "auth-status":
      return authStatus(config, env);
    case "auth-remove":
      return authRemove(command.provider, config, env);
  }
}

type Start = Extract<Command, { name: "start" }>;

function configFor(command: Start, config: Config): Config {
  // A port on the command line is as explicit as MIVRA_PORT: taken means an error, not another port.
  return command.port === undefined ? config : { ...config, port: command.port, portExplicit: true };
}

async function alreadyRunning(dataDir: string, open: boolean): Promise<boolean> {
  const state = await running(dataDir);
  if (!state) return false;
  out(`Mivra is already running at ${state.url}`);
  if (open) openBrowser(state.url);
  return true;
}

/** How long a start waits for another Mivra that's still starting in the same data dir. */
const HOLDER_WAIT_MS = 60_000;

async function startForeground(command: Start, base: Config, env: NodeJS.ProcessEnv): Promise<number> {
  const config = configFor(command, base);
  // Claim the data dir before opening the database: one Mivra per data dir, even when two start at once.
  let claimed = claim(config.dataDir);
  if (!claimed.ok) {
    const holder = await waitForHolder(config.dataDir, HOLDER_WAIT_MS);
    if (holder?.url) {
      out(`Mivra is already running at ${holder.url}`);
      if (command.open) openBrowser(holder.url);
      return 0;
    }
    // The other start gave up or died while we waited; try once more.
    claimed = claim(config.dataDir);
    if (!claimed.ok) {
      err(`Another Mivra (process ${claimed.holder.pid}) holds ${join(config.dataDir, STATE_FILE)} but doesn't answer. If it isn't running, delete that file.`);
      return 1;
    }
  }
  let server;
  try {
    server = await startServer({ config, env, webDist: webDist(), migrationsFolder: migrations(), portFallback: true, log: err });
  } catch (error) {
    clearState(config.dataDir, process.pid);
    if (error instanceof PortInUseError) {
      err(config.portExplicit ? `${error.message} Choose another with --port or MIVRA_PORT.` : `${error.message} Choose a port with --port.`);
      return 1;
    }
    if (error instanceof NewerDatabaseError) {
      err(error.message);
      return 1;
    }
    if (isNativeLoadError(error)) {
      err(`${DOCKER_HINT}\n\n${(error as Error).message}`);
      return 1;
    }
    throw error;
  }
  // Keep the claim's start time: it tells this run's record from a previous run's with the same pid.
  writeState(config.dataDir, { pid: process.pid, port: server.port, url: server.url, startedAt: readState(config.dataDir)?.startedAt ?? new Date().toISOString() });
  if (server.port !== config.port) err(`Port ${config.port} is in use, so Mivra is on ${server.port}.`);
  out(`Mivra is running at ${server.url}`);
  out(env.MIVRA_DETACHED === "1" ? `Data: ${config.dataDir}` : `Data: ${config.dataDir}. Press Ctrl+C to stop.`);
  if (command.open) openBrowser(server.url);

  return new Promise(() => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      // Exit for real, even with lesson generation or a reply still running: stopping must stop the spending.
      // Runs cut short are marked interrupted and recovered at the next start. The record goes last, so
      // `mivra stop` and a new start see this process until it's gone.
      const exit = () => {
        clearState(config.dataDir, process.pid);
        process.exit(0);
      };
      setTimeout(exit, 5000).unref();
      void server.close().then(exit, exit);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGHUP", shutdown);
  });
}

/** How long a detached start waits for the server to come up before giving up. */
const DETACH_TIMEOUT_MS = 60_000;

async function startDetached(command: Start, config: Config, env: NodeJS.ProcessEnv): Promise<number> {
  if (await alreadyRunning(config.dataDir, command.open)) return 0;
  const logPath = join(config.dataDir, LOG_FILE);
  mkdirSync(config.dataDir, { recursive: true });
  const log = openSync(logPath, "a", 0o600);
  const args = [...process.execArgv, process.argv[1]!, "start", "--no-open", ...(command.port === undefined ? [] : ["--port", String(command.port)])];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...env, MIVRA_DETACHED: "1" },
    windowsHide: true,
  });
  closeSync(log);
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code));
  child.unref();

  const deadline = Date.now() + DETACH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      // A child that found another Mivra already running says so and exits cleanly.
      const other = exited === 0 ? await running(config.dataDir) : undefined;
      if (other?.url) {
        out(`Mivra is already running at ${other.url}`);
        if (command.open) openBrowser(other.url);
        return 0;
      }
      err(`Mivra stopped while starting (exit code ${exited}). From ${logPath}:\n\n${tail(logPath)}`);
      return 1;
    }
    const state = await running(config.dataDir);
    if (state?.url && state.pid === child.pid) {
      out(`Mivra is running in the background at ${state.url}`);
      out(`Stop it with \`mivra stop\`. Log: ${logPath}`);
      if (command.open) openBrowser(state.url);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  err(`Mivra didn't start within ${DETACH_TIMEOUT_MS / 1000} s. See ${logPath}.`);
  return 1;
}

function tail(path: string, lines = 20): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

/** How long `mivra stop` waits for a clean exit before forcing one. */
const STOP_TIMEOUT_MS = 10_000;

async function stop(dataDir: string): Promise<number> {
  const state = readState(dataDir);
  if (!state || !isAlive(state.pid)) {
    if (state) clearState(dataDir, state.pid);
    out("Mivra isn't running.");
    return 0;
  }
  if (!state.url) {
    err(`Mivra (process ${state.pid}) is still starting. Try again in a moment.`);
    return 1;
  }
  // The pid could have been reused by another program since; only signal it if Mivra answers on its port.
  if (!(await running(dataDir))) {
    err(`Process ${state.pid} is recorded as Mivra but nothing answers at ${state.url}, so it was left alone. If Mivra isn't running, delete ${join(dataDir, "mivra.pid")}.`);
    return 1;
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(state.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(state.pid)) {
    process.kill(state.pid, "SIGKILL");
    err(`Mivra didn't stop within ${STOP_TIMEOUT_MS / 1000} s, so it was killed.`);
  }
  clearState(dataDir, state.pid);
  out("Mivra stopped.");
  return 0;
}

const fromEnvMessage = (provider: ProviderId) =>
  `${PROVIDER_ENV[provider]} is set in this environment, and it takes precedence over a saved key. Change or unset it instead.`;

async function authSet(provider: ProviderId, check: boolean, config: Config, env: NodeJS.ProcessEnv): Promise<number> {
  const credentials = createCredentialStore({ dataDir: config.dataDir, env });
  if (env[PROVIDER_ENV[provider]]?.trim()) {
    err(fromEnvMessage(provider));
    return 1;
  }
  let input: string;
  try {
    input = await readSecret(`Paste your ${PROVIDER_LABELS[provider]} API key (hidden): `);
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
  const key = ApiKey.safeParse(input);
  if (!key.success) {
    err(input ? key.error.issues[0]!.message : "No key given.");
    return 1;
  }
  credentials.set(provider, key.data);
  out(`Saved the ${PROVIDER_LABELS[provider]} key to ${join(config.dataDir, CREDENTIALS_FILE)}. A running Mivra uses it from the next reply.`);
  if (!check) return 0;
  const baseUrl = provider === "anthropic" ? env.ANTHROPIC_BASE_URL : provider === "openai" ? env.OPENAI_BASE_URL : undefined;
  const result = await checkProviderKey(provider, key.data, { baseUrl });
  if (result.ok) {
    out("The key works.");
    return 0;
  }
  err(`${result.message}${result.reason === "rejected" ? " It's saved anyway; replace it with `mivra auth set`." : ""}`);
  return result.reason === "rejected" ? 1 : 0;
}

function authStatus(config: Config, env: NodeJS.ProcessEnv): number {
  for (const view of createCredentialStore({ dataDir: config.dataDir, env }).views()) {
    const hint = view.hint ? `, ends in ${view.hint}` : "";
    const status = view.source === "env" ? `from ${PROVIDER_ENV[view.id]}${hint}` : view.source === "saved" ? `saved${hint}` : "not set";
    out(`${view.label.padEnd(11)} ${status}`);
  }
  return 0;
}

function authRemove(provider: ProviderId, config: Config, env: NodeJS.ProcessEnv): number {
  const removed = createCredentialStore({ dataDir: config.dataDir, env }).remove(provider);
  if (removed === "env") {
    err(fromEnvMessage(provider));
    return 1;
  }
  out(removed ? `Removed the saved ${PROVIDER_LABELS[provider]} key.` : `No ${PROVIDER_LABELS[provider]} key was saved.`);
  return 0;
}
