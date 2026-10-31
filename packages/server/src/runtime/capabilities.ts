import { ArtifactView } from "@mivra/protocol";
import { tool, type Tool, type ToolSet } from "ai";
import type { ZodType } from "zod";
import type { AttemptRow, SessionStore } from "../store/session-store.js";

/** What a tool needs to know about the turn it runs in. */
export interface TurnContext {
  sessionId: string;
  runId: string;
  store: SessionStore;
}

/** A gradable artifact kind (a check). Grading is deterministic (ADR-006). */
export interface CheckDefinition {
  answer: ZodType;
  grade(spec: unknown, answer: unknown): { correct: boolean; grade: unknown };
  /** Progress label for this check, if the spec has one. */
  concept?(spec: unknown): string | undefined;
  /** What the model sees about the learner's attempt (or its absence) on later turns. */
  describeAttempt(spec: unknown, attempt: AttemptRow | undefined): unknown;
}

/** An artifact kind the agent can produce through a tool call (ADR-006). */
export interface ArtifactKindDefinition {
  kind: string;
  version: number;
  toolName: string;
  description: string;
  /** The tool's input schema; also how the server validates and stores the spec. */
  spec: ZodType;
  /**
   * The client's view of an artifact. Must leave out private fields (e.g. a check's answer key);
   * the registry also validates every view against the strict protocol ArtifactView schema.
   */
  toView(artifact: { id: string; createdAt: Date; spec: unknown; attempt?: AttemptRow }): ArtifactView;
  check?: CheckDefinition;
}

export type ToolFactory = (ctx: TurnContext) => Tool;

/** Capabilities a plugin may use; declared up front so plugins can be isolated later (ADR-007). */
export type Capability = "artifactKinds" | "tools";

export interface PluginApi {
  registerArtifactKind(definition: ArtifactKindDefinition): void;
  /** With keepInTranscript false, calls to the tool are left out of the stored conversation. */
  registerTool(name: string, factory: ToolFactory, options?: { keepInTranscript?: boolean }): void;
}

export interface Plugin {
  name: string;
  capabilities: Capability[];
  setup(api: PluginApi): void;
}

export interface TurnTools {
  tools: ToolSet;
  /** Views of artifacts created during this turn, by tool call id, for the outgoing stream. */
  viewsByToolCall: Map<string, ArtifactView>;
}

/**
 * The in-process capability registry (ADR-007). Plugins are trusted, but may only use the
 * capabilities they declared.
 */
export function createCapabilityRegistry(plugins: Plugin[]) {
  const kinds = new Map<string, ArtifactKindDefinition>();
  const kindsByTool = new Map<string, ArtifactKindDefinition>();
  const toolFactories = new Map<string, ToolFactory>();
  const untranscribedTools = new Set<string>();

  const claimToolName = (name: string, plugin: string) => {
    if (kindsByTool.has(name) || toolFactories.has(name)) {
      throw new Error(`Plugin "${plugin}" registered tool "${name}", which is already registered`);
    }
  };

  for (const plugin of plugins) {
    const allowed = new Set(plugin.capabilities);
    const require = (capability: Capability) => {
      if (!allowed.has(capability)) throw new Error(`Plugin "${plugin.name}" did not declare the "${capability}" capability`);
    };
    plugin.setup({
      registerArtifactKind(definition) {
        require("artifactKinds");
        if (kinds.has(definition.kind)) throw new Error(`Artifact kind "${definition.kind}" is already registered`);
        claimToolName(definition.toolName, plugin.name);
        kinds.set(definition.kind, definition);
        kindsByTool.set(definition.toolName, definition);
      },
      registerTool(name, factory, options) {
        require("tools");
        claimToolName(name, plugin.name);
        toolFactories.set(name, factory);
        if (options?.keepInTranscript === false) untranscribedTools.add(name);
      },
    });
  }

  /** Builds a view and checks it against the strict wire schema, so no private field can slip out. */
  const viewOf = (definition: ArtifactKindDefinition, artifact: Parameters<ArtifactKindDefinition["toView"]>[0]) =>
    ArtifactView.parse(definition.toView(artifact));

  return {
    artifactKind: (kind: string) => kinds.get(kind),
    artifactKindForTool: (toolName: string) => kindsByTool.get(toolName),
    viewOf,
    /** Whether a stored message part should be kept when saving a reply. */
    keepsInTranscript: (partType: string) => !partType.startsWith("tool-") || !untranscribedTools.has(partType.slice(5)),

    /** The tools for one turn. Artifact tools validate their input, save the artifact and return its id. */
    toolsFor(ctx: TurnContext): TurnTools {
      const viewsByToolCall = new Map<string, ArtifactView>();
      const tools: ToolSet = {};
      for (const definition of kinds.values()) {
        tools[definition.toolName] = tool({
          description: definition.description,
          inputSchema: definition.spec as ZodType<unknown>,
          execute: async (spec: unknown, { toolCallId }) => {
            const row = ctx.store.createArtifact({
              sessionId: ctx.sessionId,
              runId: ctx.runId,
              toolCallId,
              kind: definition.kind,
              version: definition.version,
              spec,
            });
            viewsByToolCall.set(toolCallId, viewOf(definition, { id: row.id, createdAt: row.createdAt, spec }));
            return definition.check
              ? { artifactId: row.id, status: "shown", note: "The learner answers in the UI. Once they do, their result is added to this tool result." }
              : { artifactId: row.id, status: "shown" };
          },
        });
      }
      for (const [name, factory] of toolFactories) tools[name] = factory(ctx);
      return { tools, viewsByToolCall };
    },
  };
}

export type CapabilityRegistry = ReturnType<typeof createCapabilityRegistry>;
