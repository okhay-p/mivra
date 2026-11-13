import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changesToSend, collectChanges, looksSecret } from "../src/repo-files.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mivra-files-"));
  dirs.push(dir);
  return dir;
};

describe("what mivra check sends for review", () => {
  it("knows secret-looking files by name", () => {
    for (const path of [".env", ".env.local", ".env.example", "config/.env.production", "prod.env", "id_rsa", "id_ed25519", "keys/server.pem", "tls.key", "cert.p12", "credentials.json", "aws_credentials", ".npmrc", ".netrc", ".git-credentials", "secrets.yaml", "service-account-prod.json", ".ssh/config", "home/.aws/config", "terraform.tfstate"]) {
      expect(looksSecret(path), path).toBe(true);
    }
    for (const path of ["main.rs", "src/environment.py", "README.md", "id_rsa.pub", "keyboard.c", "tokens.txt", ".gitignore", "env.go"]) {
      expect(looksSecret(path), path).toBe(false);
    }
  });

  it("sends neither .env nor key files, follows .gitignore, and never follows a link", async () => {
    const repo = tempDir();
    const outside = tempDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const secret = "SECRET-do-not-send";
    const files: Record<string, string> = {
      "main.c": "int main(void) { return 0; }\n",
      ".gitignore": "out/\n",
      "out/a.out": "binary-ish",
      ".env": `TOKEN=${secret}`,
      "id_ed25519": secret,
      "deploy.key": secret,
      "README.md": `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
      "logo.png": "\u0000PNG",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    writeFileSync(join(outside, "secret.txt"), secret);
    if (process.platform !== "win32") symlinkSync(join(outside, "secret.txt"), join(repo, "link.txt"));

    const changes = await collectChanges(repo, null);
    expect(changes.source).toBe("git");
    expect(changes.files.map((f) => f.path)).toEqual([".gitignore", "main.c"]);
    expect(Object.fromEntries(changes.skipped.map((s) => [s.path, s.reason]))).toEqual({
      ".env": "secret",
      "id_ed25519": "secret",
      "deploy.key": "secret",
      "README.md": "secret",
      "logo.png": "binary",
      ...(process.platform !== "win32" ? { "link.txt": "not_a_file" } : {}),
    });
    const body = JSON.stringify(changesToSend(changes));
    expect(body).not.toContain(secret);
    expect(body).not.toMatch(/\.env|id_ed25519|deploy\.key|README|link\.txt/);
    expect(changesToSend(changes).skipped).toEqual([{ path: "logo.png", reason: "binary" }]);
  });

  it("sends nothing outside a git repository, and says why", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "main.c"), "int main;");
    const changes = await collectChanges(dir, null);
    expect(changes).toMatchObject({ source: "none", files: [] });
    expect(changes.note).toContain("git init");
  });

  it("sends everything when it doesn't know the commit it's told to compare with", async () => {
    const repo = tempDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.py"), "print(1)\n");
    const changes = await collectChanges(repo, "f".repeat(40));
    expect(changes.sinceUsed).toBe(false);
    expect(changes.files.map((f) => f.path)).toEqual(["a.py"]);
  });
});
