import { RememberInput } from "@mivra/protocol";
import { tool } from "ai";
import type { Plugin } from "../runtime/capabilities.js";
import { conceptKey } from "../runtime/learner-context.js";

/**
 * The remember tool (ADR-009). Saved memories take effect only if the reply completes, and stay hidden while a check is unanswered. The call is
 * left out of the stored conversation, so editing or deleting a memory really removes what it said.
 */
export const coreMemory: Plugin = {
  name: "core-memory",
  capabilities: ["tools"],
  setup(api) {
    api.registerTool(
      "remember",
      ({ sessionId, runId, store }) =>
        tool({
          description:
            "Save something lasting about the learner for future sessions: a goal, a preference, or a misconception. Only save what will still matter later, and not what is already known. To correct a known memory, pass its id as replaces.",
          inputSchema: RememberInput,
          execute: async (input) => {
            // The server, not the model, decides what supports a misconception.
            const key = input.kind === "misconception" && input.concept ? conceptKey(input.concept) : undefined;
            const wrongAnswer = key ? store.findLatestWrongAnswer((concept) => conceptKey(concept) === key) : undefined;
            const saved = store.saveMemory({
              sessionId,
              runId,
              kind: input.kind,
              text: input.text,
              concept: input.concept ?? null,
              replaces: input.replaces ?? null,
              attemptId: wrongAnswer?.id ?? null,
              basis: wrongAnswer ? "wrong_answer" : "chat",
            });
            return saved.ok ? { memoryId: saved.memory.id, status: "saved" } : { status: "rejected", reason: saved.reason };
          },
        }),
      { keepInTranscript: false },
    );
  },
};
