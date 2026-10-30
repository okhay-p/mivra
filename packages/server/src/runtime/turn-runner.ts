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
import { redactArtifactToolCalls, withAttemptResults } from "./artifacts.js";
import type { CapabilityRegistry } from "./capabilities.js";

export const INSTRUCTIONS = [
  "You are Mivra, a patient tutor. Explain concepts step by step, check the learner's understanding, and adapt to what they already know.",
  "You have tools that show the learner interactive artifacts. Use show_algorithm_trace when watching an algorithm's state change step by step will help. After teaching an idea, use ask_multiple_choice to check understanding.",
  "When you ask a check, don't reveal or hint at the answer in your reply; the learner answers in the UI. On later turns the check's tool result tells you how they did; respond to it.",
].join("\n\n");

/** Upper bound on model steps per turn (a step ends at each round of tool calls). */
const MAX_STEPS = 5;

/**
 * Turns the stored conversation into what the model sees. This is where learner memory will plug in
 * (ADR-007); for now it sends the whole transcript.
 */
export type AssembleContext = (conversation: UIMessage[], context: { sessionId: string }) => Promise<ModelMessage[]>;

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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The model request failed";
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
export function createTurnRunner({ store, registry, model, assembleContext = (c) => convertToModelMessages(c) }: TurnRunnerDeps) {
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
        return { ok: false, error: { kind: "unavailable", message: errorText(error) } };
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
      const { tools, viewsByToolCall } = registry.toolsFor({ sessionId, runId, store });
      let modelMessages: ModelMessage[];
      try {
        modelMessages = await assembleContext(withAttemptResults(conversation, registry, store), { sessionId });
      } catch (error) {
        store.finishRun(runId, sessionId, "failed", undefined, errorText(error));
        return { ok: false, error: { kind: "unavailable", message: errorText(error) } };
      }

      // A provider can report an error mid-stream and then close normally, which the SDK still calls
      // "completed". Remember the first error so such a run is recorded as failed.
      let streamError: unknown;
      // If the client disconnects or stops, abort the model call; the run is recorded as cancelled.
      const result = streamText({
        model: languageModel,
        instructions: INSTRUCTIONS,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal,
        onError: ({ error }) => {
          streamError ??= error;
        },
      });

      // onEnd sees the raw reply (with artifact tool calls), which is what gets stored; the client
      // gets the redacted stream.
      const stream = result.toUIMessageStream({
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
        // Provider errors (e.g. a missing API key) are shown to the learner; they are actionable.
        onError: errorText,
      });
      const response = createUIMessageStreamResponse({ stream: redactArtifactToolCalls(stream, registry, viewsByToolCall) });
      return { ok: true, response };
    },
  };
}

export type TurnRunner = ReturnType<typeof createTurnRunner>;
