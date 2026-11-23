import { ConceptGraph, LinkConceptsInput, type VaultFile } from "@mivra/protocol";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { conceptSessionEdges, conceptSessionSources, concepts, notes as notesTable, runs } from "../src/db/schema.js";
import { importVault } from "../src/notes/vault-import.js";
import { MAX_CONCEPT_NODES, createKnowledgeStore } from "../src/store/knowledge-store.js";
import { createNoteStore } from "../src/store/note-store.js";
import { createSessionStore } from "../src/store/session-store.js";

vi.setConfig({ testTimeout: 30_000 });

const auth = { authorization: "Bearer t" };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Step = { tool: string; input: unknown } | { text: string };

function setup(steps: Step[], db: Db = openDb(":memory:")) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++] ?? { text: "ok" };
      const chunks: object[] =
        "tool" in step
          ? [
              { type: "tool-call" as const, toolCallId: `call_${call}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage },
            ]
          : [
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: step.text },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
  const app = createApp({ db, model: () => model, security: { token: "t", allowedHosts: [] } });
  const newSession = async () => ((await (await app.request("/api/sessions", { method: "POST", headers: auth })).json()) as { id: string }).id;
  const turn = async (sessionId: string, text: string) => {
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    const res = await app.request(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const sse = await res.text();
    await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true));
    return sse;
  };
  const conceptGraph = async () => ConceptGraph.parse(await (await app.request("/api/concepts", { headers: auth })).json());
  const promptOf = (index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt);
  return { app, db, newSession, turn, conceptGraph, promptOf };
}

async function seedVault(db: Db, name: string, files: VaultFile[]) {
  const noteStore = createNoteStore(db);
  const outcome = await importVault(noteStore, { name, files }, [], () => ({
    status: "idle",
    pendingNotes: 0,
    groups: 0,
    groupsDone: 0,
    error: null,
    concepts: 0,
    memories: 0,
  }));
  if (!outcome.ok) throw new Error(outcome.message);
  const rows = db.select().from(notesTable).all();
  return {
    importId: outcome.result.import.id,
    noteStore,
    byPath: new Map(rows.map((r) => [r.path, r])),
    read: new Map(rows.map((r) => [r.id, r.hash])),
  };
}

describe("LinkConceptsInput schema", () => {
  it("rejects empty objects and invalid inputs (ADR-006)", () => {
    expect(LinkConceptsInput.safeParse({}).success).toBe(false);
    expect(LinkConceptsInput.safeParse({ from: "   ", to: "Recursion", kind: "prerequisite" }).success).toBe(false);
    expect(LinkConceptsInput.safeParse({ from: "Stack", to: "Recursion", kind: "invalid" }).success).toBe(false);
    expect(LinkConceptsInput.safeParse({ from: "Stack", to: "Recursion", kind: "prerequisite", extra: true }).success).toBe(false);
    expect(LinkConceptsInput.safeParse({ from: "Stack", to: "Recursion", kind: "prerequisite" }).success).toBe(true);
  });
});

describe("KnowledgeStore.saveSessionEdge & provenance", () => {
  it("normalizes via conceptKey + closeSpelling, rejects self-loops and contradictions, and deduplicates related edges", () => {
    const db = openDb(":memory:");
    const sessions = createSessionStore(db);
    const knowledge = createKnowledgeStore(db);
    const session = sessions.createSession("Study");

    const first = knowledge.saveSessionEdge({ sessionId: session.id, from: "Binary search", to: "Sorted array", kind: "related" });
    expect(first).toEqual({ ok: true, from: "Binary search", to: "Sorted array", kind: "related", created: true });

    // Close spelling collapses to existing concept names, and reversed related edge deduplicates.
    const dup = knowledge.saveSessionEdge({ sessionId: session.id, from: "sorted arrays", to: "Binary searches", kind: "related" });
    expect(dup).toEqual({ ok: true, from: "Sorted array", to: "Binary search", kind: "related", created: false });
    expect(knowledge.conceptGraph().concepts.map((c) => c.name)).toEqual(["Binary search", "Sorted array"]);
    expect(knowledge.conceptGraph().edges).toHaveLength(1);

    // Self-loops (exact and close spelling) are rejected.
    expect(knowledge.saveSessionEdge({ sessionId: session.id, from: "Binary search", to: "binary  search", kind: "related" }).ok).toBe(false);
    expect(knowledge.saveSessionEdge({ sessionId: session.id, from: "Binary search", to: "Binary searches", kind: "prerequisite" }).ok).toBe(false);

    // Contradictory prerequisites are rejected.
    const prereq = knowledge.saveSessionEdge({ sessionId: session.id, from: "Sorted array", to: "Binary search", kind: "prerequisite" });
    expect(prereq).toEqual({ ok: true, from: "Sorted array", to: "Binary search", kind: "prerequisite", created: true });
    const reverse = knowledge.saveSessionEdge({ sessionId: session.id, from: "Binary search", to: "Sorted array", kind: "prerequisite" });
    expect(reverse.ok).toBe(false);
  });

  it("preserves session-created concepts and edges across vault deletion, re-import, and session deletion", async () => {
    const db = openDb(":memory:");
    const sessions = createSessionStore(db);
    const knowledge = createKnowledgeStore(db);
    const session = sessions.createSession("CS chat");

    const { importId, noteStore, byPath, read } = await seedVault(db, "Vault", [
      { path: "Recursion.md", text: "Recursion and Call stack." },
      { path: "VaultOnly.md", text: "Vault only topic." },
    ]);
    const recNote = byPath.get("Recursion.md")!.id;
    const onlyNote = byPath.get("VaultOnly.md")!.id;

    knowledge.saveDistilled(read, {
      concepts: [
        { key: "recursion", name: "Recursion", noteIds: [recNote] },
        { key: "vault only", name: "Vault only", noteIds: [onlyNote] },
      ],
      edges: [{ fromKey: "vault only", toKey: "recursion", kind: "related", noteId: recNote }],
      memories: [],
    });

    // Session links existing vault concept "Recursion" with a new session-only concept "Call stack".
    expect(knowledge.saveSessionEdge({ sessionId: session.id, from: "Call stack", to: "Recursion", kind: "prerequisite" })).toEqual({
      ok: true,
      from: "Call stack",
      to: "Recursion",
      kind: "prerequisite",
      created: true,
    });

    // Contradiction check also works in saveDistilled against existing session prerequisites.
    const contradictory = knowledge.saveDistilled(read, {
      concepts: [{ key: "call stack", name: "Call stack", noteIds: [recNote] }],
      edges: [{ fromKey: "recursion", toKey: "call stack", kind: "prerequisite", noteId: recNote }],
      memories: [],
    });
    expect(contradictory.edges).toBe(0);

    // Re-importing the vault with an updated note drops vault-only concepts/edges, keeping session ones.
    await importVault(noteStore, { importId, files: [{ path: "Recursion.md", text: "Updated text." }] }, [], () => ({
      status: "idle",
      pendingNotes: 0,
      groups: 0,
      groupsDone: 0,
      error: null,
      concepts: 0,
      memories: 0,
    }));
    expect(knowledge.conceptGraph().concepts.map((c) => c.name)).toEqual(["Call stack", "Recursion"]);
    expect(knowledge.conceptGraph().edges).toHaveLength(1);

    // Deleting the entire vault still preserves session-supported concepts and edges.
    expect(noteStore.deleteImport(importId)).toBe(true);
    const afterVaultDelete = knowledge.conceptGraph();
    expect(afterVaultDelete.concepts).toEqual([
      { id: expect.any(String), name: "Call stack", notes: [] },
      { id: expect.any(String), name: "Recursion", notes: [] },
    ]);
    expect(afterVaultDelete.edges).toHaveLength(1);

    // Deleting the session keeps the concepts and edges, clearing session_id to null.
    expect(sessions.deleteSession(session.id)).toEqual([session.id]);
    expect(knowledge.conceptGraph().concepts.map((c) => c.name)).toEqual(["Call stack", "Recursion"]);
    expect(knowledge.conceptGraph().edges).toHaveLength(1);
    expect(db.select().from(conceptSessionSources).all().every((r) => r.sessionId === null)).toBe(true);
    expect(db.select().from(conceptSessionEdges).all().every((r) => r.sessionId === null)).toBe(true);

    // conceptNeighborhood still returns the session-created edge.
    expect(knowledge.conceptNeighborhood(["recursion"], 10)).toEqual([{ from: "Call stack", to: "Recursion", kind: "prerequisite" }]);
  });

  it("enforces MAX_CONCEPT_NODES atomically without writing partial nodes", () => {
    const db = openDb(":memory:");
    const sessions = createSessionStore(db);
    const knowledge = createKnowledgeStore(db);
    const session = sessions.createSession("Cap test");
    const now = new Date();

    // Fill to MAX_CONCEPT_NODES - 1 so adding 2 new concepts would exceed the cap.
    const rows = Array.from({ length: MAX_CONCEPT_NODES - 1 }, (_, i) => ({
      id: `c-${i}`,
      key: `concept ${i}`,
      name: `Concept ${i}`,
      createdAt: now,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      db.insert(concepts).values(rows.slice(i, i + 500)).run();
    }

    const rejected = knowledge.saveSessionEdge({ sessionId: session.id, from: "Brand new A", to: "Brand new B", kind: "related" });
    expect(rejected.ok).toBe(false);
    // Neither Brand new A nor Brand new B was inserted.
    expect(db.select().from(concepts).all()).toHaveLength(MAX_CONCEPT_NODES - 1);

    // Linking one existing concept with one new concept fits at exactly MAX_CONCEPT_NODES.
    const fits = knowledge.saveSessionEdge({ sessionId: session.id, from: "Concept 0", to: "Brand new A", kind: "related" });
    expect(fits.ok).toBe(true);
    expect(db.select().from(concepts).all()).toHaveLength(MAX_CONCEPT_NODES);

    // Linking two existing concepts still succeeds at the cap.
    const existingPair = knowledge.saveSessionEdge({ sessionId: session.id, from: "Concept 0", to: "Concept 1", kind: "prerequisite" });
    expect(existingPair.ok).toBe(true);
  });
});

describe("link_concepts tutor tool", () => {
  it("saves session concept links without leaking into SSE or stored transcript", async () => {
    const { app, db, newSession, turn, conceptGraph, promptOf } = setup([
      { tool: "link_concepts", input: { from: "Recursion", to: "Divide and conquer", kind: "prerequisite" } },
      { text: "Divide and conquer builds directly on recursion." },
    ]);
    const sessionId = await newSession();
    const sse = await turn(sessionId, "How does divide and conquer relate to recursion?");
    expect(sse).not.toContain("link_concepts");
    expect(sse).toContain("Divide and conquer builds directly on recursion.");

    const stored = await (await app.request(`/api/sessions/${sessionId}/messages`, { headers: auth })).text();
    expect(stored).not.toContain("link_concepts");
    expect(JSON.stringify(createSessionStore(db).loadMessages(sessionId))).not.toContain("link_concepts");
    expect(promptOf(1)).toContain('"status":"saved"');

    const graph = await conceptGraph();
    expect(graph.concepts.map((c) => c.name)).toEqual(["Divide and conquer", "Recursion"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.kind).toBe("prerequisite");
  });
});
