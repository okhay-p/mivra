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
