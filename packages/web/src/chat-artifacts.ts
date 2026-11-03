import { ArtifactView } from "@mivra/protocol";
import type { ChatStatus, UIMessage } from "ai";

/** True while the reply holding this message is still arriving; only the last message can be. */
export function isReplyInProgress(status: ChatStatus, messageIndex: number, messageCount: number): boolean {
  return (status === "submitted" || status === "streaming") && messageIndex === messageCount - 1;
}

/** What to render for a `data-artifact` part: a locally updated view (e.g. graded) wins over the part's data. */
export function artifactData(part: { id?: string; data: unknown }, updatedViews: Record<string, ArtifactView>): unknown {
  return (part.id && updatedViews[part.id]) || part.data;
}

/** The valid artifact views in a list of messages, by id. */
export function artifactViewsIn(messages: UIMessage[]): Record<string, ArtifactView> {
  const views: Record<string, ArtifactView> = {};
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-artifact") continue;
      const view = ArtifactView.safeParse(part.data);
      if (view.success) views[view.data.id] = view.data;
    }
  }
  return views;
}

const isGraded = (view: ArtifactView | undefined) => view?.kind === "multiple_choice" && view.latestAttempt !== undefined;

/**
 * Merges views into the local overrides. Grading is one-way, so a graded view is never replaced by
 * an ungraded one (e.g. a refresh that started before the answer was saved but returned after).
 */
export function mergeViews(
  current: Record<string, ArtifactView>,
  incoming: Record<string, ArtifactView>,
): Record<string, ArtifactView> {
  const merged = { ...current };
  for (const [id, view] of Object.entries(incoming)) {
    if (isGraded(current[id]) && !isGraded(view)) continue;
    merged[id] = view;
  }
  return merged;
}

const isPlacement = (part: UIMessage["parts"][number]) =>
  part.type === "data-artifact" && (part as { data?: { kind?: unknown } }).data?.kind === "placement_question";

/**
 * Index of the last message of a course's placement interview: the tutor's reply that followed the last
 * placement question (where it wrote the syllabus), or its first reply if the learner skipped the
 * questions. -1 if there's no reply yet.
 */
export function interviewEnd(messages: UIMessage[]): number {
  const lastQuestion = messages.findLastIndex((m) => m.parts.some(isPlacement));
  return messages.findIndex((m, i) => i > lastQuestion && m.role === "assistant" && !m.parts.some(isPlacement));
}
