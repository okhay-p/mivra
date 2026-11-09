import { RecordFromNotesInput, type DistillationView } from "@mivra/protocol";
import { stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { callOptionsFor, type ModelSelection } from "../model.js";
import type { ModelSettings } from "../models/selection.js";
import { DISTIL_INSTRUCTIONS, distilPrompt, groupNotes, validateProposal, type NoteGroup } from "../notes/distil.js";
import { resolveGraph } from "../notes/vault-import.js";
import type { KnowledgeStore } from "../store/knowledge-store.js";
import type { NoteStore } from "../store/note-store.js";
import { publicErrorText } from "./errors.js";

/** One call to record, and one more to correct rejected items. */
const DISTIL_MAX_STEPS = 2;
/** How many rejections the model is told about; the rest are only counted. */
const MAX_REJECTIONS_LISTED = 10;

export interface DistillerDeps {
  notes: NoteStore;
  knowledge: KnowledgeStore;
  model: (selection: ModelSelection) => LanguageModel;
  /** Distilling uses the app-wide model, as chat and lessons do (ADR-012). */
  models: Pick<ModelSettings, "forRun">;
}

type Job = { status: "queued" | "running" | "cancelled" | "failed" | "idle"; groups: number; groupsDone: number; error: string | null; controller?: AbortController; again?: boolean };

/**
 * Distils imported notes into concepts, edges and memories in the background (ADR-014). One import at a time, one
 * group of notes per model call. Only notes not yet distilled at their current text are read, so re-importing
 * unchanged notes costs no model call. Cancelling stops after the current call; what earlier groups saved stays, and
 * the notes not reached stay waiting for the next run.
 */
export function createDistiller({ notes, knowledge, model, models }: DistillerDeps) {
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  let pumping: Promise<void> | undefined;

  async function distilGroup(importId: string, group: NoteGroup, signal: AbortSignal) {
    const tags = knowledge.importTags(importId, 1_000);
    const nodes = knowledge.conceptNodes();
    const other = knowledge.otherConceptNames(100);
    const existing = [...new Set([...nodes.map((n) => n.name), ...other])];
    const { text, refs } = distilPrompt(group, { existing, tags });
    const read = new Map(group.notes.map((n) => [n.id, n.hash]));
    let streamError: unknown;
    const selection = models.forRun();
    const result = streamText({
      model: model(selection),
      instructions: DISTIL_INSTRUCTIONS,
      messages: [{ role: "user", content: text }],
      tools: {
        record_from_notes: tool({
          description: "Record the concepts, edges between them, and memories these notes show. Every item cites the notes it comes from.",
          inputSchema: RecordFromNotesInput,
          execute: async (input) => {
            if (signal.aborted) return { status: "cancelled" };
            const valid = validateProposal(input, refs, { nodes: knowledge.conceptNodes(), other, tags: tags.map((t) => t.tag) });
            // Notes are marked distilled once the whole call has finished, not here, so a failure leaves them waiting.
            const saved = knowledge.saveDistilled(read, valid);
            return { status: "saved", saved, rejected: valid.rejected.slice(0, MAX_REJECTIONS_LISTED), rejectedCount: valid.rejected.length };
          },
        }),
      },
      ...callOptionsFor(selection),
      // A second call only to correct rejected items; a clean first call ends it without another model request.
      stopWhen: [stepCountIs(DISTIL_MAX_STEPS), ({ steps }) => !steps.at(-1)?.toolResults.some((r) => (r.output as { rejectedCount?: number } | undefined)?.rejectedCount)],
      abortSignal: signal,
      onError: ({ error }) => {
        streamError ??= error;
      },
    });
    await result.consumeStream({ onError: (error) => void (streamError ??= error) });
    if (signal.aborted) return;
    if (streamError) throw streamError;
    // Every note read is now distilled at the text it was read with, whether or not it yielded anything.
    knowledge.markDistilled(read);
  }

  async function run(importId: string, job: Job) {
    const controller = new AbortController();
    Object.assign(job, { status: "running", groups: 0, groupsDone: 0, error: null, controller, again: false });
    try {
      const pending = knowledge.pendingNotes(importId);
      if (pending.length === 0) return;
      const graph = resolveGraph(notes.importGraph(importId));
      const links = graph.links.flatMap((l) => (l.to ? [{ from: l.from, to: l.to }] : []));
      const groups = groupNotes(pending, links);
      job.groups = groups.length;
      for (const group of groups) {
        if (controller.signal.aborted) return;
        await distilGroup(importId, group, controller.signal);
        if (!controller.signal.aborted) job.groupsDone++;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        job.status = "failed";
        job.error = publicErrorText(error);
      }
    } finally {
      job.controller = undefined;
      if (controller.signal.aborted) job.status = "cancelled";
      else if (job.status === "running") job.status = "idle";
      // A re-import while this ran may have changed notes this run read before the change.
      if (job.again && job.status === "idle" && jobs.get(importId) === job) {
        job.status = "queued";
        queue.push(importId);
      }
    }
  }

  function pump() {
    pumping ??= (async () => {
      while (queue.length > 0) {
        const importId = queue.shift()!;
        const job = jobs.get(importId);
        if (job?.status === "queued") await run(importId, job);
      }
      pumping = undefined;
    })();
    return pumping;
  }

  return {
    /** Starts distilling an import's waiting notes, or queues it behind another import. Does nothing if none wait. */
    start(importId: string) {
      const job = jobs.get(importId);
      if (job?.status === "running") {
        job.again = true;
        return;
      }
      if (job?.status === "queued") return;
      if (knowledge.countPending(importId) === 0) return;
      jobs.set(importId, { status: "queued", groups: 0, groupsDone: 0, error: null });
      queue.push(importId);
      void pump();
    },

    /** Stops distilling an import: a queued one never starts, and a running one stops after its current call. */
    cancel(importId: string): boolean {
      const job = jobs.get(importId);
      if (!job || (job.status !== "queued" && job.status !== "running")) return false;
      if (job.status === "queued") job.status = "cancelled";
      job.again = false;
      job.controller?.abort();
      return true;
    },

    /** Cancels and forgets an import, before it's deleted. */
    forget(importId: string) {
      jobs.get(importId)?.controller?.abort();
      jobs.delete(importId);
    },

    view(importId: string): DistillationView {
      const job = jobs.get(importId);
      return {
        status: job?.status ?? "idle",
        pendingNotes: knowledge.countPending(importId),
        groups: job?.groups ?? 0,
        groupsDone: job?.groupsDone ?? 0,
        error: job?.error ?? null,
        ...knowledge.counts(importId),
      };
    },

    /** Resolves once nothing is queued or running. For tests. */
    idle: async () => {
      while (pumping) await pumping;
    },
  };
}

export type Distiller = ReturnType<typeof createDistiller>;
