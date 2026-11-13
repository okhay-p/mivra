import type { ArtifactView } from "@mivra/protocol";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { artifactData, artifactViewsIn, isReplyInProgress, mergeViews } from "../src/chat-artifacts.js";
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

describe("mergeViews", () => {
  it("never replaces a graded check with an ungraded one", () => {
    // A refresh that started before the answer was saved returns after the graded view arrived.
    expect(mergeViews({ "art-mc": answered }, { "art-mc": question, "art-trace": trace })).toEqual({
      "art-mc": answered,
      "art-trace": trace,
    });
    expect(mergeViews({ "art-mc": question }, { "art-mc": answered })).toEqual({ "art-mc": answered });
  });

  it("keeps a submitted code exercise too", () => {
    const spec = { concept: "c", title: "t", instructions: "i", language: "javascript" as const, starterCode: "", cases: [{ kind: "stdio" as const, stdin: "", hidden: false }] };
    const open: ArtifactView = { id: "art-ex", createdAt: new Date(0).toISOString(), kind: "code_exercise", version: 1, spec };
    const submitted: ArtifactView = {
      ...open,
      latestAttempt: { answer: { code: "x", results: [{ stdout: "" }] }, grade: { correct: true, passed: 1, total: 1, cases: [{ passed: true }] }, createdAt: new Date(0).toISOString() },
    };
    expect(mergeViews({ "art-ex": submitted }, { "art-ex": open })).toEqual({ "art-ex": submitted });
  });
});

