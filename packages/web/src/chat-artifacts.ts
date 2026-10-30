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
