import { randomUUID } from "node:crypto";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  validateUIMessages,
  wrapLanguageModel,
  type LanguageModelMiddleware,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOutcome,
} from "ai";
import { Conflict, type RunStatus, type SessionStore } from "../store/session-store.js";
import { redactForClient, withAttemptResults } from "./artifacts.js";
import type { CapabilityRegistry } from "./capabilities.js";
import { createContinuationStream } from "./continuation-stream.js";
import { courseContext } from "./course-context.js";
import { documentContext, latestLearnerText, withDocumentExcerpts } from "./document-context.js";
import { errorText, publicErrorText } from "./errors.js";
import { MAX_EVIDENCE, MAX_MEMORIES, learnerContext } from "./learner-context.js";

export const INSTRUCTIONS = [
  "You are Mivra, a patient tutor. Explain concepts step by step, check the learner's understanding, and adapt to what they already know.",
  "You have tools that show the learner interactive artifacts inline in the chat. Refer to them as inline cards, not as a panel. After teaching an idea, use ask_multiple_choice to check understanding. Use show_algorithm_trace to watch an algorithm's state change over a sequence, show_graph for graphs, trees and algorithms that move over them, show_set_diagram for operations on up to 3 sets, show_table for truth tables, relation matrices and other tabular working, and show_worked_steps for proofs, induction and combinatorics working.",
  "When you ask a check, don't reveal or hint at the answer in your reply; the learner answers in the UI. Once the reply finishes and all its checks are answered, Mivra invokes you automatically with the graded tool results. Briefly acknowledge the result and carry the lesson forward; do not repeat the explanation already shown on the graded card.",
  // The UI treats a dollar as ordinary text when it can't be maths ("costs $5 and $10"), so \\$ is only needed for a rare ambiguous case.
  "Your replies render as markdown with LaTeX: $...$ for inline maths and $$...$$ for display maths, with no spaces just inside the single dollars. Text in artifacts renders $...$ maths but no markdown and no $$...$$, so write everything else in it as plain text; wrap all mathematical symbols in math-enabled artifact fields, including titles and explanations, in $...$ (e.g. $v_0$, never bare v_0). For a large formula, put \\displaystyle INSIDE the dollars, e.g. $\\displaystyle\\sum_{i=1}^{n} i$. In both, write a literal dollar sign as \\$. These artifact fields are plain text with no maths at all: concept names, a trace's values, pointer names, range labels and variables, and a graph's variables.",
].join("\n\n");

/** Upper bound on model steps per turn (a step ends at each round of tool calls). */
const MAX_STEPS = 5;

// Stored JSON can carry private metadata on a step boundary. Client presentation rebuilds
// step-start from its type alone; the live stream never receives these durable-only fields.
type PrivateStepStart = Extract<UIMessage["parts"][number], { type: "step-start" }> & {
  providerMetadata?: ProviderMetadata;
};

/** Restore each step's message-level options, including reasoning with no text part. */
async function replayMessages(conversation: UIMessage[]): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (const message of conversation) {
    if (message.role !== "assistant") {
      result.push(...await convertToModelMessages([message]));
      continue;
    }
    let parts: UIMessage["parts"] = [];
    let providerMetadata: PrivateStepStart["providerMetadata"];
    const flush = async () => {
      const converted = await convertToModelMessages([{ ...message, parts }]);
      result.push(...converted.map((modelMessage) => modelMessage.role === "assistant" && providerMetadata
        ? { ...modelMessage, providerOptions: providerMetadata }
        : modelMessage));
      parts = [];
    };
    for (const part of message.parts) {
      if (part.type === "step-start") {
        await flush();
        providerMetadata = (part as PrivateStepStart).providerMetadata;
      } else if (part.type !== "reasoning" || (part.providerMetadata && Object.keys(part.providerMetadata).length > 0)) {
        // Plain reasoning costs context and some providers reject unsigned replay.
        parts.push(part);
      }
    }
    await flush();
  }
  return result;
}

/**
 * Decides what the model sees for a turn (ADR-007, ADR-009). `instructions` holds what Mivra knows about
 * the learner and is added to the tutor's own, so it isn't mistaken for something the learner said.
 * `messages` is only what this turn's model call sees: it can hold context nobody stores or shows.
 * A custom assembler replaces all of this, so including the learner's record is up to it.
 */
export type AssembleContext = (
  conversation: UIMessage[],
  context: { sessionId: string },
) => Promise<{ messages: ModelMessage[]; instructions?: string }>;

/** The whole transcript, plus the learner's record across sessions and the session's documents. Summaries will plug in here. */
const defaultAssembleContext =
  (store: SessionStore, registry: CapabilityRegistry): AssembleContext =>
  async (conversation, { sessionId }) => {
    const documents = documentContext(store, sessionId, latestLearnerText(conversation.filter(m => m.id !== "mivra-continuation-event")));
    return {
      messages: withDocumentExcerpts(
        await replayMessages(conversation),
        documents?.excerpts,
      ),
      instructions: [
        learnerContext(store.listRecentEvidence(MAX_EVIDENCE), store.listMemoriesForModel(registry.checkKinds(), MAX_MEMORIES)),
        courseContext(store, sessionId),
        documents?.rules,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  };

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
  /** Documents ready when Send was pressed; omitted by older clients. */
  documentIds?: string[];
  /** Internal server trigger, never a learner message. */
  continuation?: boolean;
  /** Aborts the model call, e.g. when the client disconnects. */
  abortSignal?: AbortSignal;
}

function runStatusFor(outcome: UIMessageStreamOutcome): RunStatus {
  if (outcome.status === "completed") return "completed";
  if (outcome.status === "failed") return "failed";
  return "cancelled";
}

/**
 * Providers can error their transport stream instead of emitting an SDK error part. Normalize at
 * the model boundary, on every step: otherwise the error escapes the UI stream and reaches Hono's
 * response writer. An error part uses the SDK's normal onError/onEnd path and closes SSE cleanly.
 */
const containStreamErrors: LanguageModelMiddleware = {
  wrapStream: async ({ doStream, params }) => {
    params.abortSignal?.throwIfAborted();
    const result = await doStream();
    const reader = result.stream.getReader();
    let cancelled = false;
    return {
      ...result,
      stream: new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) {
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(value);
          } catch (error) {
            if (cancelled) return;
            reader.releaseLock();
            controller.enqueue({ type: "error", error });
            controller.close();
          }
        },
        async cancel(reason) {
          cancelled = true;
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      }),
    };
  },
};

const CONTINUATION_EVENT = "Mivra session event (not a learner message): all checks in the preceding reply have been answered. Respond briefly to their graded tool results and continue the lesson, without repeating the card explanation.";
function continuationEvent(): UIMessage {
  return { id: "mivra-continuation-event", role: "user", parts: [{ type: "text", text: CONTINUATION_EVENT }] };
}

/**
 * Runs one chat turn: validate the learner's message, claim the session's run, assemble context,
 * stream the model's reply, and record how the run ended. Returns the reply as an AI SDK UI message
 * stream (SSE) response.
 */
export function createTurnRunner({ store, registry, model, assembleContext = defaultAssembleContext(store, registry) }: TurnRunnerDeps) {
  type ActiveTurn = {
    controller: AbortController;
    stopId: string;
    continuation: boolean;
    broadcast: ReturnType<typeof createContinuationStream>;
  };
  const active = new Map<string, ActiveTurn>();
  // A Stop can overtake the chat POST. Remember its message id, with a fixed bound on stale ids.
  const stopped = new Set<string>();
  const runner = {
    async subscribeContinuation(sessionId: string) {
      const previous = store.latestRun(sessionId);
      const failure: Record<string, string> = previous?.continuationOf && previous.status === "failed"
        ? { "x-mivra-continuation-error": "The model request failed." } : {};
      // Session load/focus/visibility triggers recovery; the store enforces its durable budget
      // and cooldown atomically with the claim. No retry loop runs in the background.
      if (!active.has(sessionId) && previous?.continuationOf && previous.status === "failed") {
        await runner.continueAfterAnswer(sessionId);
      }
      const run = active.get(sessionId);
      if (!run?.continuation) {
        // A tab may have missed the entire run while hidden, including a failure before streaming.
        const latest = store.latestRun(sessionId);
        return new Response(null, {
          status: 204,
          headers: latest?.continuationOf && latest.status === "failed"
            ? { "x-mivra-continuation-error": "The model request failed." }
            : failure,
        });
      }
      return createUIMessageStreamResponse({ stream: run.broadcast.subscribe(), headers: {
        ...failure, "x-mivra-continuation-stop-id": run.stopId,
      } });
    },
    async continueAfterAnswer(sessionId: string) {
      try {
        await runner.startTurn({ sessionId, continuation: true, message: undefined });
      } catch (error) {
        const run = store.latestRun(sessionId);
        if (run?.continuationOf && run.status === "running") {
          const turn = active.get(sessionId);
          active.delete(sessionId);
          if (turn?.continuation) {
            turn.broadcast.push({ type: "error", errorText: publicErrorText(error) });
            turn.broadcast.close();
          }
          store.finishRun(run.id, sessionId, "failed", undefined, errorText(error));
        }
      }
    },
    stopTurn(sessionId: string, messageId: string) {
      const turn = active.get(sessionId);
      if (turn?.stopId === messageId) return turn.controller.abort();
      if (!store.findSession(sessionId)) return;
      stopped.add(JSON.stringify([sessionId, messageId]));
      if (stopped.size > 256) stopped.delete(stopped.values().next().value!);
    },
    async startTurn({ sessionId, message: input, documentIds, abortSignal, continuation = false }: StartTurnInput): Promise<StartTurnResult> {
      const session = store.findSession(sessionId);
      if (!session) return { ok: false, error: { kind: "not_found", message: "Session not found" } };

      const readyDocumentIds = continuation ? [] : documentIds ?? store.listDocuments(sessionId).filter(d => d.messageId === null).map(d => d.id);

      let runId!: string;
      let message: UIMessage;
      if (continuation) {
        const claimed = store.startContinuation(sessionId, registry.checkKinds());
        if (!claimed) return { ok: false, error: { kind: "conflict", message: "No continuation is pending" } };
        runId = claimed.id;
        message = { id: claimed.userMessageId, role: "user", parts: [] };
      } else try {
        [message] = (await validateUIMessages({ messages: [input] })) as [UIMessage];
      } catch (error) {
        return { ok: false, error: { kind: "invalid", message: error instanceof Error ? error.message : "Invalid message" } };
      }
      if (message.role !== "user") return { ok: false, error: { kind: "invalid", message: "Only user messages can be sent" } };

      let languageModel: LanguageModel;
      try {
        languageModel = model();
      } catch (error) {
        if (continuation) store.finishRun(runId!, sessionId, "failed", undefined, errorText(error));
        return { ok: false, error: { kind: "unavailable", message: publicErrorText(error) } };
      }

      if (!continuation) try {
        runId = store.startRun(session, message);
      } catch (error) {
        if (error instanceof Conflict) return { ok: false, error: { kind: "conflict", message: error.message } };
        throw error;
      }

      const cancellation = new AbortController();
      // Automatic turns share the originating learner message in storage, but Stop must target
      // this run alone: a delayed Stop must never cancel the next automatically generated quiz.
      const stopId = continuation ? runId : message.id;
      const activeTurn: ActiveTurn = { controller: cancellation, stopId, continuation, broadcast: createContinuationStream() };
      active.set(sessionId, activeTurn);
      if (stopped.delete(JSON.stringify([sessionId, stopId]))) cancellation.abort();
      const signal = abortSignal ? AbortSignal.any([abortSignal, cancellation.signal]) : cancellation.signal;
      const cancelledBeforeStream = (): StartTurnResult => {
        active.delete(sessionId);
        activeTurn.broadcast.push({ type: "abort" });
        activeTurn.broadcast.close();
        store.finishRun(runId, sessionId, "cancelled");
        store.bindDocuments(sessionId, message.id, readyDocumentIds);
        return { ok: true, response: createUIMessageStreamResponse({
          stream: new ReadableStream<UIMessageChunk>({
            start(controller) { controller.enqueue({ type: "abort" }); controller.close(); },
          }),
        }) };
      };
      if (signal.aborted) return cancelledBeforeStream();

      // Load history after claiming the run, so it cannot change underneath this turn.
      const conversation = store.loadMessages(sessionId, true);
      let turnTools: ReturnType<CapabilityRegistry["toolsFor"]>;
      let assembled: Awaited<ReturnType<AssembleContext>>;
      try {
        // Plugin code runs here, so any failure must still release the run.
        turnTools = registry.toolsFor({ sessionId, runId, store });
        const gradedConversation = withAttemptResults(conversation, registry, store);
        // A model-only session event separates automatic assistant turns and closes the prompt.
        // It is never persisted or presented as a learner bubble. Tool call/result pairs remain intact.
        const context = gradedConversation.flatMap((m, index) =>
          m.role === "assistant" && gradedConversation[index - 1]?.role === "assistant" ? [continuationEvent(), m] : [m]);
        if (continuation) context.push(continuationEvent());
        assembled = await assembleContext(context, { sessionId });
      } catch (error) {
        if (signal.aborted) return cancelledBeforeStream();
        active.delete(sessionId);
        store.finishRun(runId, sessionId, "failed", undefined, errorText(error));
        activeTurn.broadcast.push({ type: "error", errorText: "Couldn't start the reply." });
        activeTurn.broadcast.close();
        // Plugin or context code failed; its message isn't known to be safe to show.
        return { ok: false, error: { kind: "unavailable", message: "Couldn't start the reply." } };
      }

      if (signal.aborted) return cancelledBeforeStream();

      // A provider can report an error mid-stream and then close normally, which the SDK still calls
      // "completed". Remember the first error so such a run is recorded as failed.
      let streamError: unknown;
      const stepMetadata: PrivateStepStart["providerMetadata"][] = [];
      let hasReplyText = false;
      const emptyReplyError = new Error("The model ended the turn without reply text or an artifact.");
      const hasOutput = () => hasReplyText || turnTools.viewsByToolCall.size > 0;
      // If the client disconnects or stops, abort the model call; the run is recorded as cancelled.
      const result = streamText({
        model: typeof languageModel === "string" ? languageModel : wrapLanguageModel({ model: languageModel, middleware: containStreamErrors }),
        instructions: assembled.instructions ? `${INSTRUCTIONS}\n\n${assembled.instructions}` : INSTRUCTIONS,
        messages: assembled.messages,
        tools: turnTools.tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: signal,
        onStepEnd: ({ providerMetadata }) => { stepMetadata.push(providerMetadata); },
        onChunk: ({ chunk }) => {
          if (chunk.type === "text-delta" && chunk.text.trim()) hasReplyText = true;
        },
        onError: ({ error }) => {
          streamError ??= error;
        },
      });

      // onEnd sees the raw reply (with artifact tool calls), which is what gets stored; the client
      // gets the redacted stream.
      const stream = result.toUIMessageStream({
        // Only reasoning text survives client redaction; provider details stay server-side.
        sendReasoning: true,
        sendSources: false,
        originalMessages: continuation ? [] : conversation,
        generateMessageId: randomUUID,
        onEnd: ({ responseMessage, outcome }) => {
          active.delete(sessionId);
          if (outcome.status === "completed" && !hasOutput()) streamError ??= emptyReplyError;
          if (streamError !== undefined && outcome.status === "completed") {
            return store.finishRun(runId, sessionId, "failed", undefined, errorText(streamError));
          }
          const status = runStatusFor(outcome);
          const error = outcome.status === "failed" ? errorText(outcome.error ?? streamError) : undefined;
          let step = 0;
          const reply = { ...responseMessage, parts: responseMessage.parts
            .map((part) => part.type === "step-start" ? { ...part, providerMetadata: stepMetadata[step++] } : part)
            .filter((part) => registry.keepsInTranscript(part.type)) };
          store.finishRun(runId, sessionId, status, reply, error);
        },
        // Only known-safe errors reach the learner (e.g. a missing API key); detail stays in runs.error.
        onError: publicErrorText,
      });
      let finishChunk: UIMessageChunk | undefined;
      const clientStream = redactForClient(stream, turnTools.viewsByToolCall).pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            if (chunk.type === "finish") finishChunk = chunk;
            else controller.enqueue(chunk);
          },
          flush(controller) {
            // Wait for onEnd to classify a bounded repair loop with no learner-visible output.
            if (streamError === emptyReplyError) {
              controller.enqueue({ type: "error", errorText: publicErrorText(emptyReplyError) });
            }
            if (finishChunk) controller.enqueue(finishChunk);
          },
        }),
      );
      // All rejection paths are above: a successful response accepts this user message.
      store.bindDocuments(sessionId, message.id, readyDocumentIds);
      if (continuation) {
        // This pump owns the provider stream. Cancelling a subscriber only detaches that tab.
        void (async () => {
          try {
            for await (const chunk of clientStream) {
              activeTurn.broadcast.push(chunk);
            }
          } catch (error) {
            if (store.latestRun(sessionId)?.id === runId && store.latestRun(sessionId)?.status === "running") {
              active.delete(sessionId);
              store.finishRun(runId, sessionId, "failed", undefined, errorText(error));
            }
            activeTurn.broadcast.push({ type: "error", errorText: publicErrorText(error) });
          } finally {
            activeTurn.broadcast.close();
          }
        })();
        return { ok: true, response: new Response(null, { status: 204 }) };
      }
      const response = createUIMessageStreamResponse({ stream: clientStream });
      return { ok: true, response };
    },
  };
  return runner;
}

export type TurnRunner = ReturnType<typeof createTurnRunner>;
