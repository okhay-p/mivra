import { CompositionSpec, compositionArtifactKind, type CompositionArtifactView } from "@mivra/protocol";
import type { ArtifactKindDefinition } from "../runtime/capabilities.js";

/**
 * The client's view of a stored composition (#109). The spec has no private fields, so the view is the
 * whole spec, parsed again with the stored schema so an old artifact stays readable when the authoring
 * checks change, and so nothing outside the strict schema can reach a client.
 */
export function compositionView({ id, createdAt, spec }: { id: string; createdAt: Date; spec: unknown }): CompositionArtifactView {
  return { id, createdAt: createdAt.toISOString(), kind: "composition", version: 1, spec: CompositionSpec.parse(spec) };
}

/**
 * composition's registration, ready but not registered: no plugin passes it to `registerArtifactKind`
 * until the web can render it (#113), so the model is never offered show_composition before then. The
 * activation steps are listed on `compositionArtifactKind`. Explanatory only: no check, so viewing and
 * stepping record no attempt or evidence.
 */
export const compositionKindDefinition = {
  kind: "composition",
  version: compositionArtifactKind.version,
  toolName: compositionArtifactKind.toolName,
  description: compositionArtifactKind.description,
  spec: compositionArtifactKind.input,
  toView: compositionView,
} satisfies Omit<ArtifactKindDefinition, "toView"> & { toView: typeof compositionView };
