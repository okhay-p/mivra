import { randomUUID } from "node:crypto";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  validateUIMessages,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
  type UIMessageStreamOutcome,
} from "ai";
import { Conflict, type RunStatus, type SessionStore } from "../store/session-store.js";
import { redactForClient, withAttemptResults } from "./artifacts.js";
import type { CapabilityRegistry } from "./capabilities.js";
import { errorText, publicErrorText } from "./errors.js";
import { MAX_EVIDENCE, learnerContext } from "./learner-context.js";

export const INSTRUCTIONS = [
  "You are Mivra, a patient tutor. Explain concepts step by step, check the learner's understanding, and adapt to what they already know.",
  "You have tools that show the learner interactive artifacts. Use show_algorithm_trace when watching an algorithm's state change step by step will help. After teaching an idea, use ask_multiple_choice to check understanding.",
  "When you ask a check, don't reveal or hint at the answer in your reply; the learner answers in the UI. On later turns the check's tool result tells you how they did; respond to it.",
].join("\n\n");

/** Upper bound on model steps per turn (a step ends at each round of tool calls). */
const MAX_STEPS = 5;

/**
 * Decides what the model sees for a turn (ADR-007, ADR-009). `instructions` holds what Mivra knows about
 * the learner and is added to the tutor's own, so it isn't mistaken for something the learner said.
 * A custom assembler replaces all of this, so including the learner's record is up to it.
 */
export type AssembleContext = (
  conversation: UIMessage[],
  context: { sessionId: string },
) => Promise<{ messages: ModelMessage[]; instructions?: string }>;

/** The whole transcript, plus the learner's record across sessions. Summaries will plug in here. */
const defaultAssembleContext =
  (store: SessionStore): AssembleContext =>
  async (conversation) => ({
    messages: await convertToModelMessages(conversation),
    instructions: learnerContext(store.listRecentEvidence(MAX_EVIDENCE)),
  });

export interface TurnRunnerDeps {
  store: SessionStore;
  registry: CapabilityRegistry;
  model: () => LanguageModel;
  assembleContext?: AssembleContext;
}

/** Why a turn couldn't start. The HTTP layer maps these to status codes. */
export type TurnError =
  | { kind: "not_found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "unavailable"; message: string };

export type StartTurnResult = { ok: true; response: Response } | { ok: false; error: TurnError };

export interface StartTurnInput {
  sessionId: string;
  /** The new user message, unvalidated. */
  message: unknown;
  /** Aborts the model call, e.g. when the client disconnects. */
  abortSignal?: AbortSignal;
}

function runStatusFor(outcome: UIMessageStreamOutcome): RunStatus {
  if (outcome.status === "completed") return "completed";
  if (outcome.status === "failed") return "failed";
  return "cancelled";
}

/**
 * Runs one chat turn: validate the learner's message, claim the session's run, assemble context,
 * stream the model's reply, and record how the run ended. Returns the reply as an AI SDK UI message
 * stream (SSE) response.
 */
export function createTurnRunner({ store, registry, model, assembleContext = defaultAssembleContext(store) }: TurnRunnerDeps) {
  return {
    async startTurn({ sessionId, message: input, abortSignal }: StartTurnInput): Promise<StartTurnResult> {
      const session = store.findSession(sessionId);
      if (!session) return { ok: false, error: { kind: "not_found", message: "Session not found" } };

      let message: UIMessage;
      try {
        [message] = (await validateUIMessages({ messages: [input] })) as [UIMessage];
      } catch (error) {
        return { ok: false, error: { kind: "invalid", message: error instanceof Error ? error.message : "Invalid message" } };
      }
      if (message.role !== "user") return { ok: false, error: { kind: "invalid", message: "Only user messages can be sent" } };

      let languageModel: LanguageModel;
      try {
        languageModel = model();
      } catch (error) {
        return { ok: false, error: { kind: "unavailable", message: publicErrorText(error) } };
      }

      let runId: string;
      try {
        runId = store.startRun(session, message);
      } catch (error) {
        if (error instanceof Conflict) return { ok: false, error: { kind: "conflict", message: error.message } };
        throw error;
      }

      // Load history after claiming the run, so it cannot change underneath this turn.
      const conversation = store.loadMessages(sessionId);
      let turnTools: ReturnType<CapabilityRegistry["toolsFor"]>;
      let assembled: Awaited<ReturnType<AssembleContext>>;
      try {
        // Plugin code runs here, so any failure must still release the run.
        turnTools = registry.toolsFor({ sessionId, runId, store });
        assembled = await assembleContext(withAttemptResults(conversation, registry, store), { sessionId });
      } catch (error) {
        store.finishRun(runId, sessionId, "failed", undefined, errorText(error));
        // Plugin or context code failed; its message isn't known to be safe to show.
        return { ok: false, error: { kind: "unavailable", message: "Couldn't start the reply." } };
      }

      // A provider can report an error mid-stream and then close normally, which the SDK still calls
      // "completed". Remember the first error so such a run is recorded as failed.
      let streamError: unknown;
      // If the client disconnects or stops, abort the model call; the run is recorded as cancelled.
      const result = streamText({
        model: languageModel,
        instructions: assembled.instructions ? `${INSTRUCTIONS}\n\n${assembled.instructions}` : INSTRUCTIONS,
        messages: assembled.messages,
        tools: turnTools.tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal,
        onError: ({ error }) => {
          streamError ??= error;
        },
      });

      // onEnd sees the raw reply (with artifact tool calls), which is what gets stored; the client
      // gets the redacted stream.
      const stream = result.toUIMessageStream({
        // Reasoning can quote tool inputs, including a check's answer key.
        sendReasoning: false,
        sendSources: false,
        originalMessages: conversation,
        generateMessageId: randomUUID,
        onEnd: ({ responseMessage, outcome }) => {
          if (streamError !== undefined && outcome.status === "completed") {
            return store.finishRun(runId, sessionId, "failed", undefined, errorText(streamError));
          }
          const status = runStatusFor(outcome);
          const error = outcome.status === "failed" ? errorText(outcome.error ?? streamError) : undefined;
          store.finishRun(runId, sessionId, status, responseMessage, error);
        },
        // Only known-safe errors reach the learner (e.g. a missing API key); detail stays in runs.error.
        onError: publicErrorText,
      });
      const response = createUIMessageStreamResponse({ stream: redactForClient(stream, turnTools.viewsByToolCall) });
      return { ok: true, response };
    },
  };
}

export type TurnRunner = ReturnType<typeof createTurnRunner>;
