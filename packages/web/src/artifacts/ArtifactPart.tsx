import { ArtifactView, type ArtifactKind } from "@mivra/protocol";
import type { ComponentType } from "react";
import { AlgorithmTrace } from "./AlgorithmTrace.js";
import { MultipleChoice } from "./MultipleChoice.js";

export interface ArtifactProps<K extends ArtifactKind> {
  view: Extract<ArtifactView, { kind: K }>;
  /** True while the reply that contains this artifact is still streaming. */
  replyInProgress: boolean;
  /** Replaces the artifact's view, e.g. with the graded view after an attempt. */
  onUpdate: (view: ArtifactView) => void;
}

/** One renderer per artifact kind. A new kind in `artifactKinds` fails type-checking here until it has one. */
const renderers: { [K in ArtifactKind]: ComponentType<ArtifactProps<K>> } = {
  algorithm_trace: AlgorithmTrace,
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
}: {
  data: unknown;
  replyInProgress: boolean;
  onUpdate: (view: ArtifactView) => void;
}) {
  const parsed = ArtifactView.safeParse(data);
  if (!parsed.success) {
    return (
      <div className="artifact artifact-invalid" role="note">
        Can't display this item.
      </div>
    );
  }
  const view = parsed.data;
  const Renderer = renderers[view.kind] as ComponentType<ArtifactProps<typeof view.kind>>;
  return <Renderer view={view} replyInProgress={replyInProgress} onUpdate={onUpdate} />;
}
