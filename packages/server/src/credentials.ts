import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Providers Mivra holds an API key for (ADR-012, ADR-013). */
export const providerIds = ["openrouter", "anthropic", "openai"] as const;
export type ProviderId = (typeof providerIds)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = { openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI" };

/** The environment variable that sets each provider's key. It wins over a saved key. */
export const PROVIDER_ENV: Record<ProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export type ProviderKeys = Partial<Record<ProviderId, string>>;

/** What a client may know about a key: never the key itself (ADR-013). */
export interface ProviderKeyView {
  id: ProviderId;
  label: string;
  /** `env` keys come from the environment and can't be changed from Mivra. */
  source: "env" | "saved" | null;
  /** The key's last four characters, to tell keys apart. */
  hint: string | null;
}

export const CREDENTIALS_FILE = "credentials.json";

/** Keys are opaque tokens: printable ASCII without spaces. Real ones are 40–200 characters. */
export const ApiKey = z
  .string()
  .trim()
  .min(8, "That's too short to be an API key")
  .max(500, "That's too long to be an API key")
  .regex(/^[\x21-\x7e]+$/, "An API key has no spaces or special characters");

/**
 * `credentials.json`. Besides API keys it can hold the Mivra server this machine's `mivra check` talks to, when that
 * runs on another machine (ADR-016): its address and API token. Sections a store doesn't use are kept as they are.
 */
const CredentialsFile = z.looseObject({ keys: z.record(z.string(), z.string()).default({}) });
type CredentialsFile = z.infer<typeof CredentialsFile>;

/** A Mivra server's API token, as `mivra token` prints it: printable ASCII without spaces. Real ones are 43 characters. */
export const ServerToken = z
  .string()
  .trim()
  .min(16, "That's too short to be a Mivra token")
  .max(500, "That's too long to be a Mivra token")
  .regex(/^[\x21-\x7e]+$/, "A Mivra token has no spaces or special characters");

/** The Mivra on another machine that `mivra link` and `mivra check` use instead of the local one (ADR-016). */
export const RemoteServer = z.object({ url: z.string().url(), token: ServerToken });
export type RemoteServer = z.infer<typeof RemoteServer>;

export interface CredentialStore {
  /** The key each provider uses now: the environment's, else the saved one. Read fresh on every call. */
  keys(): ProviderKeys;
  views(): ProviderKeyView[];
  /** Saves a key to the credentials file. Refused for a provider whose key comes from the environment. */
  set(provider: ProviderId, key: string): { ok: true } | { ok: false; reason: "env" };
  /** Removes a saved key; true if there was one. */
  remove(provider: ProviderId): boolean | "env";
  /**
   * A custom provider's key (issue #69): its environment variable, else the one saved under `custom:<id>`. Kept
   * apart from the built-in keys, so a custom endpoint never receives another provider's key.
   */
  customKey(id: string, envName: string): { key: string | undefined; source: "env" | "saved" | null };
  setCustomKey(id: string, key: string): void;
  removeCustomKey(id: string): boolean;
}

const hintFor = (key: string) => (key.length >= 12 ? key.slice(-4) : null);

interface SavedKeys {
  load(): Record<string, string>;
  save(keys: Record<string, string>): void;
}

function credentialStore(envVar: (name: string) => string | undefined, saved: SavedKeys): CredentialStore {
  const fromEnv = (provider: ProviderId) => envVar(PROVIDER_ENV[provider]);
  const customName = (id: string) => `custom:${id}`;
  return {
    keys() {
      const stored = saved.load();
      return Object.fromEntries(providerIds.flatMap((p) => {
        const key = fromEnv(p) ?? stored[p];
        return key ? [[p, key]] : [];
      }));
    },
    views() {
      const stored = saved.load();
      return providerIds.map((id) => {
        const env = fromEnv(id);
        const key = env ?? stored[id];
        return { id, label: PROVIDER_LABELS[id], source: env ? "env" : key ? "saved" : null, hint: key ? hintFor(key) : null };
      });
    },
    set(provider, key) {
      if (fromEnv(provider)) return { ok: false, reason: "env" };
      saved.save({ ...saved.load(), [provider]: ApiKey.parse(key) });
      return { ok: true };
    },
    remove(provider) {
      if (fromEnv(provider)) return "env";
      const stored = saved.load();
      if (!(provider in stored)) return false;
      delete stored[provider];
      saved.save(stored);
      return true;
    },
    customKey(id, envName) {
      const env = envVar(envName);
      if (env) return { key: env, source: "env" };
      const key = saved.load()[customName(id)];
      return key ? { key, source: "saved" } : { key: undefined, source: null };
    },
    setCustomKey(id, key) {
      saved.save({ ...saved.load(), [customName(id)]: ApiKey.parse(key) });
    },
    removeCustomKey(id) {
      const stored = saved.load();
      if (!(customName(id) in stored)) return false;
      delete stored[customName(id)];
      saved.save(stored);
      return true;
    },
  };
}

/**
 * API keys from the environment or `credentials.json` in the data dir (ADR-013). The file is written with
 * mode 0600 and kept out of the database, so backing up or copying `mivra.db` never carries a key. It's read
 * on every call, so a key saved by `mivra auth` applies to a running server from its next run.
 */
export function createCredentialStore({ dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }): CredentialStore {
  const file = credentialsFile(dataDir);
  return credentialStore((name) => env[name]?.trim() || undefined, {
    load: () => file.read().keys,
    save: (keys) => file.write({ ...file.read(), keys }),
  });
}

/**
 * Reads and writes `credentials.json` whole. The file is written with mode 0600 and kept out of the database, so
 * backing up or copying `mivra.db` never carries a secret.
 */
function credentialsFile(dataDir: string) {
  const path = join(dataDir, CREDENTIALS_FILE);
  // The file is read on every lookup; warn about a broken one once, not on every run.
  let warned = false;
  return {
    read(): CredentialsFile {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return { keys: {} };
      }
      try {
        return CredentialsFile.parse(JSON.parse(text));
      } catch {
        if (!warned) console.warn(`${path} isn't valid, so its keys are ignored. Fix or delete it, or set the keys again.`);
        warned = true;
        return { keys: {} };
      }
    },
    write(contents: CredentialsFile) {
      mkdirSync(dataDir, { recursive: true });
      // Write a private temp file and rename it over the old one, so a reader never sees half a file and the
      // secrets are never readable by other users, even briefly.
      const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}

/** The remote Mivra saved with `mivra link --server`, if any. One that doesn't parse counts as none. */
export function readRemoteServer(dataDir: string): RemoteServer | undefined {
  const parsed = RemoteServer.safeParse(credentialsFile(dataDir).read().server);
  return parsed.success ? parsed.data : undefined;
}

/** Saves the remote Mivra for `mivra link` and `mivra check`, beside any API keys. */
export function saveRemoteServer(dataDir: string, server: RemoteServer) {
  const file = credentialsFile(dataDir);
  file.write({ ...file.read(), server: RemoteServer.parse(server) });
}

/** Forgets the remote Mivra, so the CLI uses the local one again; true if one was saved. */
export function removeRemoteServer(dataDir: string): boolean {
  const file = credentialsFile(dataDir);
  const { server, ...rest } = file.read();
  if (server === undefined) return false;
  file.write(rest as CredentialsFile);
  return true;
}

/**
 * Keys held in memory, for tests and the e2e harness: `env` keys act like environment variables, as do `vars`
 * (by variable name, for custom providers' keys).
 */
export function memoryCredentials({ env = {}, saved = {}, vars = {} }: { env?: ProviderKeys; saved?: ProviderKeys & Record<string, string>; vars?: Record<string, string> } = {}): CredentialStore {
  let stored: Record<string, string> = { ...saved } as Record<string, string>;
  const byName = Object.fromEntries(providerIds.flatMap((p) => (env[p] ? [[PROVIDER_ENV[p], env[p]]] : [])));
  return credentialStore((name) => byName[name] ?? vars[name], {
    load: () => ({ ...stored }),
    save: (keys) => (stored = { ...keys }),
  });
}

/** A stable string for a set of keys, to rebuild what depends on them only when they change. */
export const keysSignature = (keys: ProviderKeys) => providerIds.map((p) => keys[p] ?? "").join("\n");
