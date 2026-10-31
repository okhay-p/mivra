import { ArtifactView, type ArtifactKind } from "@mivra/protocol";
import type { ComponentType } from "react";
import { AlgorithmTrace } from "./AlgorithmTrace.js";
import { Graph } from "./Graph.js";
import { MultipleChoice } from "./MultipleChoice.js";

export interface ArtifactProps<K extends ArtifactKind> {
  view: Extract<ArtifactView, { kind: K }>;
  /** True while the reply that contains this artifact is still streaming. */
  replyInProgress: boolean;
  /** Replaces the artifact's view, e.g. with the graded view after an attempt. */
  onUpdate: (view: ArtifactView) => void;
  /** Reloads the session's artifact views from the server, e.g. when a local view may be stale. */
  onRefresh: () => Promise<void>;
}

/** One renderer per artifact kind. A new kind in `artifactKinds` fails type-checking here until it has one. */
const renderers: { [K in ArtifactKind]: ComponentType<ArtifactProps<K>> } = {
  algorithm_trace: AlgorithmTrace,
  graph: Graph,
  multiple_choice: MultipleChoice,
};

/**
 * Renders a `data-artifact` message part. The data is validated against the protocol first, so
 * anything unexpected shows a placeholder instead of a half-rendered item (fail closed).
 */
export function ArtifactPart({
  data,
  replyInProgress,
  onUpdate,
  onRefresh,
}: { data: unknown } & Omit<ArtifactProps<ArtifactKind>, "view">) {
  const parsed = ArtifactView.safeParse(data);
  if (!parsed.success) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm" role="note">
        Can't display this item.
      </div>
    );
  }
  const view = parsed.data;
  const Renderer = renderers[view.kind] as ComponentType<ArtifactProps<typeof view.kind>>;
  return <Renderer view={view} replyInProgress={replyInProgress} onUpdate={onUpdate} onRefresh={onRefresh} />;
}
