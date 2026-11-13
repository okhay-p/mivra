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

  it("has help and version flags", () => {
    expect(parseCommand(["--help"])).toEqual({ name: "help" });
    expect(parseCommand(["-v"])).toEqual({ name: "version" });
  });
});
