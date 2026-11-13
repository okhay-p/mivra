import { describe, expect, it } from "vitest";
import { UsageError, parseCommand } from "../src/args.js";

describe("the command line", () => {
  it("starts in the foreground and opens the browser by default", () => {
    expect(parseCommand([])).toEqual({ name: "start", port: undefined, open: true, detach: false });
    expect(parseCommand(["start", "--detach", "--no-open", "--port", "5000"])).toEqual({ name: "start", port: 5000, open: false, detach: true });
  });

  it("reads auth commands", () => {
    expect(parseCommand(["auth", "set", "openrouter"])).toEqual({ name: "auth-set", provider: "openrouter", check: true });
    expect(parseCommand(["auth", "set", "anthropic", "--no-check"])).toEqual({ name: "auth-set", provider: "anthropic", check: false });
    expect(parseCommand(["auth", "status"])).toEqual({ name: "auth-status" });
    expect(parseCommand(["auth", "remove", "openai"])).toEqual({ name: "auth-remove", provider: "openai" });
    expect(parseCommand(["auth", "login", "chatgpt"])).toEqual({ name: "auth-login", newAccount: false, open: true });
    expect(parseCommand(["auth", "login", "--new-account", "--no-open"])).toEqual({ name: "auth-login", newAccount: true, open: false });
    expect(parseCommand(["auth", "logout", "chatgpt"])).toEqual({ name: "auth-logout" });
    expect(() => parseCommand(["auth", "login", "openrouter"])).toThrow(UsageError);
  });

  it("reads the import command", () => {
    expect(parseCommand(["import", "obsidian", "~/Vault"])).toEqual({ name: "import-obsidian", folder: "~/Vault" });
    expect(parseCommand(["import", "obsidian", "Vault", "--name", "Uni notes"])).toEqual({ name: "import-obsidian", folder: "Vault", importName: "Uni notes" });
    for (const argv of [["import"], ["import", "notion", "x"], ["import", "obsidian"], ["import", "obsidian", "a", "b"]]) {
      expect(() => parseCommand(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("reads the uninstall command", () => {
    expect(parseCommand(["uninstall"])).toEqual({ name: "uninstall", deleteData: undefined });
    expect(parseCommand(["uninstall", "--delete-data"])).toEqual({ name: "uninstall", deleteData: true });
    expect(parseCommand(["uninstall", "--keep-data"])).toEqual({ name: "uninstall", deleteData: false });
    expect(() => parseCommand(["uninstall", "--delete-data", "--keep-data"])).toThrow(UsageError);
    expect(() => parseCommand(["uninstall", "now"])).toThrow(UsageError);
  });

  it("never takes a key as an argument", () => {
    expect(() => parseCommand(["auth", "set", "openrouter", "sk-or-v1-secret"])).toThrow(UsageError);
  });

  it("refuses what it doesn't understand", () => {
    for (const argv of [["bogus"], ["start", "--port", "0"], ["start", "--port", "http"], ["auth"], ["auth", "set"], ["auth", "set", "mistral"], ["stop", "now"], ["--frobnicate"]]) {
      expect(() => parseCommand(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("reads project course commands", () => {
    expect(parseCommand(["link", "c1", "--run", " ./build/mycc {input} "])).toEqual({ name: "link", course: "c1", run: "./build/mycc {input}", local: false });
    expect(parseCommand(["link", "c1", "--run", "./mycc {input}", "--run-output", "./run.sh {output}"])).toEqual({ name: "link", course: "c1", run: "./mycc {input}", runOutput: "./run.sh {output}", local: false });
    expect(() => parseCommand(["link", "--run", "./mycc"])).toThrow(/course's id/);
    expect(() => parseCommand(["link", "c1"])).toThrow(/--run/);
    expect(parseCommand(["check"])).toEqual({ name: "check", timeoutS: 10, dryRun: false });
    expect(parseCommand(["check", "--timeout", "2.5"])).toEqual({ name: "check", timeoutS: 2.5, dryRun: false });
    expect(parseCommand(["check", "--dry-run"])).toEqual({ name: "check", timeoutS: 10, dryRun: true });
    expect(() => parseCommand(["check", "--timeout", "0"])).toThrow(UsageError);
    expect(() => parseCommand(["check", "extra"])).toThrow(UsageError);
  });

  it("reads a remote server for link, as an origin, and never a token", () => {
    expect(parseCommand(["link", "--server", "https://home.tail1.ts.net/"])).toEqual({ name: "link", server: "https://home.tail1.ts.net", local: false });
    expect(parseCommand(["link", "c1", "--run", "./mycc", "--server", "http://100.64.0.1:4096"])).toEqual({ name: "link", course: "c1", run: "./mycc", server: "http://100.64.0.1:4096", local: false });
    expect(parseCommand(["link", "--local"])).toEqual({ name: "link", local: true });
    expect(parseCommand(["token"])).toEqual({ name: "token" });
    expect(() => parseCommand(["link", "--server", "https://h.ts.net", "--local"])).toThrow(/not both/);
    expect(() => parseCommand(["link", "--server", "home.ts.net"])).toThrow(/address/);
    expect(() => parseCommand(["link", "--server", "ftp://h.ts.net"])).toThrow(/http/);
    expect(() => parseCommand(["link", "--server", "https://me:secret@h.ts.net"])).toThrow(/user name/);
    expect(() => parseCommand(["link", "--server", "https://h.ts.net/mivra"])).toThrow(/without a path/);
    expect(() => parseCommand(["link", "--server", "https://h.ts.net/?token=x"])).toThrow(/without a path/);
    expect(() => parseCommand(["link", "--server", "https://h.ts.net", "--run", "./mycc"])).toThrow(/course's id/);
    expect(() => parseCommand(["link", "--server", "https://h.ts.net", "--token", "x"])).toThrow();
    expect(() => parseCommand(["token", "extra"])).toThrow(/Unexpected/);
  });

  it("has help and version flags", () => {
    expect(parseCommand(["--help"])).toEqual({ name: "help" });
    expect(parseCommand(["-v"])).toEqual({ name: "version" });
  });
});
