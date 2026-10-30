import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { artifactData, artifactViewsIn, isReplyInProgress } from "../src/chat-artifacts.js";
import { answered, question, trace } from "./fixtures.js";

const part = (data: unknown, id?: string) => ({ type: "data-artifact" as const, id, data });
const message = (id: string, parts: UIMessage["parts"]): UIMessage => ({ id, role: "assistant", parts });

describe("isReplyInProgress", () => {
  it("only holds for the last message while the reply is submitted or streaming", () => {
    expect(isReplyInProgress("streaming", 2, 3)).toBe(true);
    expect(isReplyInProgress("submitted", 2, 3)).toBe(true);
    // An older check stays answerable during a newer reply.
    expect(isReplyInProgress("streaming", 1, 3)).toBe(false);
    expect(isReplyInProgress("ready", 2, 3)).toBe(false);
    expect(isReplyInProgress("error", 2, 3)).toBe(false);
  });
});

describe("artifactData", () => {
  it("prefers a locally updated view over the part's data", () => {
    expect(artifactData(part(question, "art-mc"), { "art-mc": answered })).toBe(answered);
    expect(artifactData(part(question, "art-mc"), { other: answered })).toBe(question);
    expect(artifactData(part(question), { "art-mc": answered })).toBe(question);
  });
});

describe("artifactViewsIn", () => {
  it("collects valid views by id and skips invalid ones", () => {
    const messages = [
      message("u1", [{ type: "text", text: "hi" }]),
      message("a1", [part(trace, "art-trace"), part({ kind: "mystery" }, "x"), part(answered, "art-mc")]),
    ];
    expect(artifactViewsIn(messages)).toEqual({ "art-trace": trace, "art-mc": answered });
  });
});
