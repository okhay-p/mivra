import { LinkConceptsInput, RememberInput } from "@mivra/protocol";
import { tool } from "ai";
import type { Plugin } from "../runtime/capabilities.js";
import { conceptKey } from "../runtime/learner-context.js";

/**
 * The remember and link_concepts tools (ADR-009, ADR-014). Saved memories take effect only if the reply completes,
 * and stay hidden while a check is unanswered. Both calls are left out of the stored conversation, so editing or
 * deleting a memory or updating the concept graph stays decoupled from chat history.
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
            "Save something about the learner for future sessions, as soon as you learn it: a goal, deadline or exam; a preference for how they learn; a misconception they showed more than once; or a takeaway from a finished lesson or course, saved as a goal or preference. Don't repeat what Mivra already knows about them. To correct or update a known memory, pass its id as replaces.",
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

    api.registerTool(
      "link_concepts",
      ({ sessionId, knowledge }) =>
        tool({
          description:
            "Record a relationship between two concepts in the learner's concept graph (prerequisite: `from` must be understood before `to`; related: closely linked concepts). Use this when teaching or connecting key ideas so the learner's concept graph grows from live sessions too. Reuse existing concept names from <learner_concepts> or <learner_concept_graph> when one fits.",
          inputSchema: LinkConceptsInput,
          execute: async (input) => {
            if (!knowledge) return { status: "rejected" as const, reason: "Concept graph is unavailable." };
            const saved = knowledge.saveSessionEdge({ sessionId, from: input.from, to: input.to, kind: input.kind });
            return saved.ok
              ? { status: "saved" as const, from: saved.from, to: saved.to, kind: saved.kind, created: saved.created }
              : { status: "rejected" as const, reason: saved.reason };
          },
        }),
      { keepInTranscript: false, availableIn: ({ knowledge }) => Boolean(knowledge) },
    );
  },
};
