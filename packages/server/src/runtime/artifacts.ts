import type { ArtifactView } from "@mivra/protocol";
import type { UIMessage, UIMessageChunk } from "ai";
import type { SessionStore } from "../store/session-store.js";
import type { ArtifactKindDefinition, CapabilityRegistry } from "./capabilities.js";

/**
 * Artifact tool calls carry private fields (a check's answer key) in their input, and model
 * reasoning can quote them. Stored messages keep everything, because the model needs its own tool
 * calls as context. Everything sent to a client goes through this module, which fails closed: only
 * allowlisted part and chunk types pass, and artifact tool calls become `data-artifact` parts
 * holding the public view. Unknown tools (including artifact tools whose plugin is no longer
 * loaded), reasoning, sources and files are dropped.
 */

/** Message part types a client may receive as stored. */
const CLIENT_PART_TYPES = new Set(["text", "step-start"]);

/** Stream chunk types a client may receive as produced by the SDK. */
const CLIENT_CHUNK_TYPES = new Set([
  "start",
  "finish",
  "abort",
  "error",
  "message-metadata",
  "start-step",
  "finish-step",
  "reset-step",
  "text-start",
  "text-delta",
  "text-end",
]);

type Part = UIMessage["parts"][number];

interface ArtifactToolPart {
  definition: ArtifactKindDefinition;
  part: Part & { toolCallId: string; state: string; input?: unknown; output?: unknown };
  artifactId: string | undefined;
}

function artifactToolPart(part: Part, registry: CapabilityRegistry): ArtifactToolPart | undefined {
  const toolName =
    part.type === "dynamic-tool" ? (part as { toolName: string }).toolName : part.type.startsWith("tool-") ? part.type.slice(5) : undefined;
  const definition = toolName ? registry.artifactKindForTool(toolName) : undefined;
  if (!definition) return undefined;
  const toolPart = part as ArtifactToolPart["part"];
  const output = toolPart.state === "output-available" ? (toolPart.output as { artifactId?: unknown } | undefined) : undefined;
  return { definition, part: toolPart, artifactId: typeof output?.artifactId === "string" ? output.artifactId : undefined };
}

function dataPart(view: ArtifactView): Part {
  return { type: "data-artifact", id: view.id, data: view } as Part;
}

/** Current view of a stored artifact, including the learner's attempt for checks. */
export function artifactView(artifactId: string, registry: CapabilityRegistry, store: SessionStore): ArtifactView | undefined {
  const row = store.findArtifact(artifactId);
  const definition = row && registry.artifactKind(row.kind);
  if (!row || !definition) return undefined;
  return registry.viewOf(definition, { id: row.id, createdAt: row.createdAt, spec: row.spec, attempt: store.findAttempt(row.id) });
}

/**
 * Stored messages as a client may see them: allowlisted parts as-is, finished artifact tool calls as
 * views, everything else dropped.
 */
export function presentMessages(messages: UIMessage[], registry: CapabilityRegistry, store: SessionStore): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (CLIENT_PART_TYPES.has(part.type)) return [part];
      const artifactPart = artifactToolPart(part, registry);
      const view = artifactPart?.artifactId && artifactView(artifactPart.artifactId, registry, store);
      return view ? [dataPart(view)] : [];
    }),
  }));
}

/**
 * Filters the outgoing UI message stream: passes only allowlisted chunk types, and emits a
 * `data-artifact` chunk with the view when an artifact tool call's output arrives (that is, once the
 * artifact is saved). Every other tool chunk, reasoning, sources and files are dropped.
 */
export function redactForClient(
  stream: ReadableStream<UIMessageChunk>,
  viewsByToolCall: Map<string, ArtifactView>,
): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (CLIENT_CHUNK_TYPES.has(chunk.type)) return controller.enqueue(chunk);
        if (chunk.type === "tool-output-available") {
          const view = viewsByToolCall.get(chunk.toolCallId);
          if (view) controller.enqueue({ type: "data-artifact", id: view.id, data: view } as UIMessageChunk);
        }
      },
    }),
  );
}

/**
 * The conversation as the model should see it: each check's tool result is extended with the
 * learner's attempt (or that they haven't answered yet), so the tutor can react to it.
 */
export function withAttemptResults(conversation: UIMessage[], registry: CapabilityRegistry, store: SessionStore): UIMessage[] {
  return conversation.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      const artifactPart = artifactToolPart(part, registry);
      const check = artifactPart?.definition.check;
      if (!artifactPart?.artifactId || !check) return part;
      const row = store.findArtifact(artifactPart.artifactId);
      if (!row) return part;
      const result = check.describeAttempt(row.spec, store.findAttempt(row.id));
      return { ...artifactPart.part, output: { ...(artifactPart.part.output as object), ...(result as object) } } as Part;
    }),
  }));
}
