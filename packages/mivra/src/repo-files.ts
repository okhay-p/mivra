import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { MAX_REVIEW_FILES, MAX_REVIEW_FILE_CHARS, MAX_REVIEW_PATH_CHARS, MAX_REVIEW_TOTAL_CHARS, type ReviewFile, type ReviewSkipReason } from "@mivra/protocol";

/**
 * What `mivra check` sends for review (ADR-016): the files changed since the last passed milestone, as git sees them,
 * so `.gitignore` (and the learner's global excludes) are followed exactly. Secret-looking files never leave the
 * machine, not even by name; binary files, lockfiles and anything past the size caps are left out and named. Outside
 * a git repository nothing is sent. Symbolic links are never followed, so a link can't send a file from elsewhere.
 */

/** Why a file wasn't sent. Only `ReviewSkipReason`s are reported to the server; the rest stay on this machine. */
export type LocalSkipReason = ReviewSkipReason | "secret" | "not_a_file";

export interface Changes {
  source: "git" | "none";
  /** Why nothing could be collected, for the learner. */
  note?: string;
  /** The commit checked out now, if there is one. */
  commit?: string;
  /** Whether the files are the changes since `since` (true), or every file because there was no `since` or git didn't know it. */
  sinceUsed: boolean;
  files: ReviewFile[];
  skipped: { path: string; reason: LocalSkipReason }[];
  deleted: string[];
}

/** Lockfiles: generated, often huge, and nothing to review. */
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "composer.lock", "gemfile.lock", "go.sum", "flake.lock", "mix.lock", "pubspec.lock", "podfile.lock", "packages.lock.json"]);

/** Folders whose contents are credentials. */
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", "secrets", ".secrets"]);

/** File names that hold credentials, whole (lower-cased). */
const SECRET_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  ".dockercfg",
  "credentials",
  "authorized_keys",
  "known_hosts",
  "terraform.tfvars",
]);

/** Name patterns that hold credentials (tested against the lower-cased base name). */
const SECRET_PATTERNS = [
  /^\.env($|[-_.])/, // .env, .env.local, .env-production, .env_prod, .env.example: all of them
  /\.env$/, // prod.env
  /^\.?envrc$/,
  /\.(pem|key|p8|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx|tfstate|tfvars|secret|secrets)$/,
  /\.tfstate\.backup$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
  /credential/,
  /^secrets?\./,
  /^service[-_]?account.*\.json$/,
  /^client_secret.*\.json$/,
  // Tokens, keys and passwords kept in data files (not source files: a lexer's token.c is code, not a secret).
  /(^|[-_.])(api[-_]?keys?|(access|auth|api|bearer|refresh|github|slack|bot)[-_]?tokens?|passwords?|passwd|secrets?)([-_.][^/]*)?\.(json|ya?ml|toml|ini|cfg|conf|txt|properties|xml)$/,
];

/** Text that only a private key contains, in any file. */
const PRIVATE_KEY = /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----/;

/** Whether a path (relative, with `/` or the platform's separator) looks like it holds a secret, by its name alone. */
export function looksSecret(path: string): boolean {
  const parts = path.split(/[\\/]/).map((p) => p.toLowerCase());
  const secretName = (name: string) => SECRET_NAMES.has(name) || SECRET_PATTERNS.some((pattern) => pattern.test(name));
  // A folder named like a secret (`.env/`, `credentials/`) holds secrets too.
  if (parts.slice(0, -1).some((dir) => SECRET_DIRS.has(dir) || secretName(dir))) return true;
  return secretName(parts.at(-1) ?? "");
}

/** Runs git in `cwd` without a shell. Rejects if it fails. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // core.quotepath off: paths come back as they are, not escaped.
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

const splitZ = (text: string) => text.split("\0").filter((p) => p !== "");
const toSlash = (path: string) => path.split(sep).join("/");

/** The changed paths since `since`, and those deleted; or every path if `since` is null or unknown to this repository. */
async function changedPaths(root: string, since: string | null): Promise<{ paths: string[]; deleted: string[]; sinceUsed: boolean }> {
  // Untracked files that aren't ignored count as changes either way.
  const untracked = splitZ(await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  if (since && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(since)) {
    const known = await git(root, ["cat-file", "-e", `${since}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (known) {
      // The working tree against that commit: staged and unstaged changes alike, under this folder only.
      const fields = splitZ(await git(root, ["diff", "--name-status", "-z", "--no-renames", "--relative", since, "--", "."]));
      const paths: string[] = [];
      const deleted: string[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        (fields[i] === "D" ? deleted : paths).push(fields[i + 1]!);
      }
      return { paths: [...new Set([...paths, ...untracked])], deleted, sinceUsed: true };
    }
  }
  const tracked = splitZ(await git(root, ["ls-files", "-z", "--cached"]));
  return { paths: [...new Set([...tracked, ...untracked])], deleted: [], sinceUsed: false };
}

/** Reads one file if it may be sent: a regular file inside `root`, not secret, binary or too large. */
async function readCandidate(root: string, realRoot: string, path: string): Promise<{ ok: true; content: string } | { ok: false; reason: LocalSkipReason | "gone" }> {
  if (looksSecret(path)) return { ok: false, reason: "secret" };
  if (LOCKFILES.has(basename(path).toLowerCase())) return { ok: false, reason: "lockfile" };
  if (path.length > MAX_REVIEW_PATH_CHARS) return { ok: false, reason: "too_large" };
  const full = join(root, path);
  let info;
  try {
    info = await lstat(full);
  } catch {
    return { ok: false, reason: "gone" };
  }
  // A symbolic link could point anywhere, a ~/.ssh key included: never followed. Submodules are folders.
  if (!info.isFile()) return { ok: false, reason: "not_a_file" };
  // A folder on the way may itself be a link out of the repository.
  const real = await realpath(full).catch(() => undefined);
  const rel = real === undefined ? undefined : relative(realRoot, real);
  if (rel === undefined || rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, reason: "not_a_file" };
  // UTF-8 never takes more than 4 bytes a character: anything larger can't fit.
  if (info.size > MAX_REVIEW_FILE_CHARS * 4) return { ok: false, reason: "too_large" };
  const bytes = await readFile(full).catch(() => undefined);
  if (!bytes) return { ok: false, reason: "gone" };
  if (bytes.subarray(0, 8000).includes(0)) return { ok: false, reason: "binary" };
  const content = bytes.toString("utf8");
  if (PRIVATE_KEY.test(content)) return { ok: false, reason: "secret" };
  if (content.length > MAX_REVIEW_FILE_CHARS) return { ok: false, reason: "too_large" };
  return { ok: true, content };
}

/** Collects what `mivra check` sends for review from `root`, the folder holding `.mivra.json`. */
export async function collectChanges(root: string, since: string | null): Promise<Changes> {
  try {
    if ((await git(root, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") throw new Error("not a work tree");
  } catch {
    return {
      source: "none",
      note: "This folder isn't in a git repository (or git isn't installed), so Mivra can't tell which files to send for review, or which are ignored. Run `git init` here.",
      sinceUsed: false,
      files: [],
      skipped: [],
      deleted: [],
    };
  }
  const commit = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  const { paths, deleted, sinceUsed } = await changedPaths(root, since);
  const realRoot = await realpath(root);
  const files: ReviewFile[] = [];
  const skipped: Changes["skipped"] = [];
  let total = 0;
  for (const path of paths.map(toSlash).sort()) {
    const read = await readCandidate(root, realRoot, path);
    if (!read.ok) {
      if (read.reason !== "gone") skipped.push({ path, reason: read.reason });
      continue;
    }
    if (files.length >= MAX_REVIEW_FILES || total + read.content.length > MAX_REVIEW_TOTAL_CHARS) {
      skipped.push({ path, reason: "size_cap" });
      continue;
    }
    total += read.content.length;
    files.push({ path, content: read.content });
  }
  return {
    source: "git",
    ...(/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit) ? { commit } : {}),
    sinceUsed,
    files,
    skipped,
    deleted: deleted.map(toSlash).filter((p) => !looksSecret(p) && p.length <= MAX_REVIEW_PATH_CHARS).slice(0, 1000),
  };
}

/** The reasons the server may hear: a secret, a link or a folder is left out without its name. */
const SENDABLE: ReadonlySet<LocalSkipReason> = new Set<ReviewSkipReason>(["binary", "too_large", "size_cap", "lockfile"]);

/** What of the changes goes in a check's body. */
export function changesToSend(changes: Changes) {
  return {
    source: changes.source,
    ...(changes.commit ? { commit: changes.commit } : {}),
    files: changes.files,
    skipped: changes.skipped.filter((s): s is { path: string; reason: ReviewSkipReason } => SENDABLE.has(s.reason)).slice(0, 1000),
    deleted: changes.deleted,
  };
}
