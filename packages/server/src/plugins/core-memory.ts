import { RememberInput } from "@mivra/protocol";
import { tool } from "ai";
import type { Plugin } from "../runtime/capabilities.js";
import { MAX_EVIDENCE, conceptKey } from "../runtime/learner-context.js";

/**
 * The remember tool (ADR-009). Saved memories take effect only if the reply completes. The call is
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
            const wrongAnswer =
              input.kind === "misconception" && input.concept
                ? store
                    .listRecentEvidence(MAX_EVIDENCE)
                    .find((a) => !a.correct && a.concept && conceptKey(a.concept) === conceptKey(input.concept!))
                : undefined;
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
            return saved ? { memoryId: saved.id, status: "saved" } : { status: "rejected", reason: "replaces isn't a known memory id" };
          },
        }),
      { keepInTranscript: false },
    );
  },
};
