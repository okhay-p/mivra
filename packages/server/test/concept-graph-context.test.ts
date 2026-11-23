import type { VaultFile } from "@mivra/protocol";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { artifacts, attempts, lessons as lessonsTable, notes as notesTable, runs } from "../src/db/schema.js";
import { importVault } from "../src/notes/vault-import.js";
import { createKnowledgeStore, type ConceptGraphEdge } from "../src/store/knowledge-store.js";
import { createLessonStore } from "../src/store/lesson-store.js";
import { createNoteStore } from "../src/store/note-store.js";
import { createSessionStore } from "../src/store/session-store.js";

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const block = (text: string | undefined, name: string) => new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text ?? "")?.[1];
const graphRows = (text: string | undefined): ConceptGraphEdge[] =>
  (block(text, "learner_concept_graph") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ConceptGraphEdge);

/** Imports notes directly into SQLite (without running distillation) and returns note rows by path. */
async function seedNotes(db: Db, name: string, files: VaultFile[]) {
  const noteStore = createNoteStore(db);
  await importVault(noteStore, { name, files }, [], () => ({
    status: "idle",
    pendingNotes: 0,
    groups: 0,
    groupsDone: 0,
    error: null,
    concepts: 0,
    memories: 0,
  }));
  const rows = db.select().from(notesTable).all();
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const read = new Map(rows.map((r) => [r.id, r.hash]));
  return { byPath, read };
}

describe("KnowledgeStore concept lookups", () => {
  it("conceptsForNotes returns deduplicated concepts in deterministic key order and respects limit", async () => {
    const db = openDb(":memory:");
    const knowledge = createKnowledgeStore(db);
    const { byPath, read } = await seedNotes(db, "Vault", [
      { path: "a.md", text: "Recursion and Stack." },
      { path: "b.md", text: "Stack and Trees." },
      { path: "c.md", text: "Unrelated note." },
    ]);
    const a = byPath.get("a.md")!.id;
    const b = byPath.get("b.md")!.id;
    const c = byPath.get("c.md")!.id;
    knowledge.saveDistilled(read, {
      concepts: [
        { key: "trees", name: "Trees", noteIds: [b] },
        { key: "stack", name: "Stack", noteIds: [a, b] },
        { key: "recursion", name: "Recursion", noteIds: [a] },
      ],
      edges: [],
      memories: [],
    });

    expect(knowledge.conceptsForNotes([])).toEqual([]);
    expect(knowledge.conceptsForNotes([c])).toEqual([]);
    expect(knowledge.conceptsForNotes([a, b], 0)).toEqual([]);
    expect(knowledge.conceptsForNotes([b, a, a])).toEqual([
      { key: "recursion", name: "Recursion" },
      { key: "stack", name: "Stack" },
      { key: "trees", name: "Trees" },
    ]);
    expect(knowledge.conceptsForNotes([a, b], 2)).toEqual([
      { key: "recursion", name: "Recursion" },
      { key: "stack", name: "Stack" },
    ]);
  });

  it("conceptNeighborhood returns bounded, deterministic 1-hop edges with priority ordering", async () => {
    const db = openDb(":memory:");
    const knowledge = createKnowledgeStore(db);
    const { byPath, read } = await seedNotes(db, "Vault", [
      { path: "n1.md", text: "Note 1" },
      { path: "n2.md", text: "Note 2" },
    ]);
    const n1 = byPath.get("n1.md")!.id;
    const n2 = byPath.get("n2.md")!.id;
    knowledge.saveDistilled(read, {
      concepts: [
        { key: "arrays", name: "Arrays", noteIds: [n1] },
        { key: "stack", name: "Stack", noteIds: [n1, n2] },
        { key: "recursion", name: "Recursion", noteIds: [n1, n2] },
        { key: "memoization", name: "Memoization", noteIds: [n1] },
        { key: "dynamic programming", name: "Dynamic Programming", noteIds: [n1] },
        { key: "trees", name: "Trees", noteIds: [n1] },
      ],
      edges: [
        // Prerequisite between two seeds ("stack" and "recursion"), supported by 2 notes.
        { fromKey: "stack", toKey: "recursion", kind: "prerequisite", noteId: n1 },
        { fromKey: "stack", toKey: "recursion", kind: "prerequisite", noteId: n2 },
        // Prerequisite touching one seed ("recursion" -> "memoization"), supported by 1 note.
        { fromKey: "recursion", toKey: "memoization", kind: "prerequisite", noteId: n1 },
        // Related edge between "trees" and "recursion" (reversed order to test key canonicalization).
        { fromKey: "trees", toKey: "recursion", kind: "related", noteId: n1 },
        // 2-hop edge away from "recursion": memoization -> dynamic programming.
        { fromKey: "memoization", toKey: "dynamic programming", kind: "prerequisite", noteId: n1 },
        // Prerequisite into "stack": arrays -> stack.
        { fromKey: "arrays", toKey: "stack", kind: "prerequisite", noteId: n1 },
      ],
      memories: [],
    });

    expect(knowledge.conceptNeighborhood([], 10)).toEqual([]);
    expect(knowledge.conceptNeighborhood(["unknown"], 10)).toEqual([]);
    expect(knowledge.conceptNeighborhood(["recursion"], 0)).toEqual([]);

    // 1-hop from "Recursion" only: excludes 2-hop memoization -> dynamic programming and arrays -> stack.
    const oneHop = knowledge.conceptNeighborhood(["  RECURSION  "], 10);
    expect(oneHop).toEqual([
      { from: "Stack", to: "Recursion", kind: "prerequisite" },
      { from: "Recursion", to: "Memoization", kind: "prerequisite" },
      { from: "Recursion", to: "Trees", kind: "related" },
    ]);

    // With both "recursion" and "stack" as seeds, the edge between two seeds comes first regardless of input order.
    const twoSeedsA = knowledge.conceptNeighborhood(["recursion", "stack"], 10);
    const twoSeedsB = knowledge.conceptNeighborhood(["Stack", "Recursion"], 10);
    expect(twoSeedsA).toEqual(twoSeedsB);
    expect(twoSeedsA[0]).toEqual({ from: "Stack", to: "Recursion", kind: "prerequisite" });
    expect(twoSeedsA).toContainEqual({ from: "Arrays", to: "Stack", kind: "prerequisite" });
    expect(twoSeedsA).not.toContainEqual({ from: "Memoization", to: "Dynamic Programming", kind: "prerequisite" });

    // Respects limit.
    expect(knowledge.conceptNeighborhood(["recursion", "stack"], 2)).toEqual(twoSeedsA.slice(0, 2));
  });
});

describe("concept graph in chat turns, placement interviews, and lesson generation", () => {
  async function setup() {
    const db = openDb(":memory:");
    const systems: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        systems.push(options.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
        const chunks = [
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: "ok" },
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
        ];
        return { stream: simulateReadableStream({ chunks }) as never };
      },
    });
    const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
    const store = createSessionStore(db);
    const lessons = createLessonStore(db);
    const knowledge = createKnowledgeStore(db);

    const { byPath, read } = await seedNotes(db, "CS Vault", [
      { path: "CS/Recursion.md", text: "# Recursion\nA recursive function calls itself and needs a base case.\n" },
      { path: "CS/Stack.md", text: "# Stack\nA call stack stores stack frames.\n" },
      { path: "Maths/Limits.md", text: "# Limits\nA limit describes what a function approaches.\n" },
    ]);
    const recNote = byPath.get("CS/Recursion.md")!.id;
    const stackNote = byPath.get("CS/Stack.md")!.id;
    const limitsNote = byPath.get("Maths/Limits.md")!.id;
    knowledge.saveDistilled(read, {
      concepts: [
        { key: "stack", name: "Stack", noteIds: [stackNote] },
        { key: "recursion", name: "Recursion", noteIds: [recNote] },
        { key: "induction", name: "Induction", noteIds: [recNote] },
        { key: "limits", name: "Limits", noteIds: [limitsNote] },
        { key: "derivatives", name: "Derivatives", noteIds: [limitsNote] },
      ],
      edges: [
        { fromKey: "stack", toKey: "recursion", kind: "prerequisite", noteId: recNote },
        { fromKey: "induction", toKey: "recursion", kind: "related", noteId: recNote },
        { fromKey: "limits", toKey: "derivatives", kind: "prerequisite", noteId: limitsNote },
      ],
      memories: [],
    });

    const turn = async (sessionId: string, text: string, lessonId?: string) => {
      const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
      const res = await app.request(`/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ message, ...(lessonId ? { lessonId } : {}) }),
      });
      expect(res.status).toBe(200);
      await res.text();
      await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true));
      return systems.at(-1)!;
    };

    return { app, db, store, lessons, systems, turn };
  }

  it("includes relevant concept edges on a chat turn when notes match, and omits them when nothing matches", async () => {
    const { store, turn } = await setup();
    const session = store.createSession("Free chat");

    const unrelated = await turn(session.id, "Explain photosynthesis");
    expect(unrelated).not.toContain("<learner_concept_graph>");

    const matched = await turn(session.id, "Why does recursion need a base case?");
    // Both Induction and Recursion are supported by Recursion.md, so the edge between two seeds ranks first.
    expect(graphRows(matched)).toEqual([
      { from: "Induction", to: "Recursion", kind: "related" },
      { from: "Stack", to: "Recursion", kind: "prerequisite" },
    ]);
  });

  it("seeds concept edges from recently practised concepts and ranks <learner_concept_graph> below <learner_concepts>", async () => {
    const { db, store, turn } = await setup();
    const session = store.createSession("Practice");
    const msgId = crypto.randomUUID();
    const runId = store.startRun(session, { id: msgId, role: "user", parts: [{ type: "text", text: "hi" }] });
    store.finishRun(runId, session.id, "completed");
    const artifactId = crypto.randomUUID();
    db.insert(artifacts)
      .values({ id: artifactId, sessionId: session.id, runId, toolCallId: "tc1", kind: "multiple_choice", version: 1, spec: {}, createdAt: new Date() })
      .run();
    db.insert(attempts)
      .values({ id: crypto.randomUUID(), artifactId, sessionId: session.id, answer: {}, grade: {}, correct: false, concept: "Derivatives", judge: "grader", createdAt: new Date() })
      .run();

    const sys = await turn(session.id, "What should I review next?");
    expect(sys.indexOf("<learner_concepts>")).toBeGreaterThan(-1);
    expect(sys.indexOf("<learner_concept_graph>")).toBeGreaterThan(sys.indexOf("<learner_concepts>"));
    expect(graphRows(sys)).toEqual([{ from: "Limits", to: "Derivatives", kind: "prerequisite" }]);
  });

  it("includes concept edges during a course placement interview and in a course lesson chat", async () => {
    const { store, lessons, turn } = await setup();

    // Placement interview seeded by course goal matching a distilled concept.
    const { session: interviewSession } = store.createCourse("Derivatives");
    const interviewSys = await turn(interviewSession.id, "Let's begin");
    expect(graphRows(interviewSys)).toEqual([{ from: "Limits", to: "Derivatives", kind: "prerequisite" }]);

    // Active course chat with an open lesson seeded by that lesson's syllabus topic.
    const { course, session: courseSession } = store.createCourse("Algorithms");
    store.writeFirstSyllabus(course.id, null, {
      topics: [{ title: "Recursive thinking", summary: "s", reason: "r", requestedByLearner: false, concepts: ["Recursion"] }],
      known: [],
    });
    const [topic] = store.latestSyllabus(course.id)!.topics;
    const { lesson } = lessons.createLesson({ courseId: course.id, topicId: topic!.id, topicTitle: topic!.title, position: 0 });
    const lessonChatSys = await turn(courseSession.id, "Can you give me a hint?", lesson.id);
    expect(graphRows(lessonChatSys)).toEqual([
      { from: "Stack", to: "Recursion", kind: "prerequisite" },
      { from: "Induction", to: "Recursion", kind: "related" },
    ]);
  });

  it("feeds relevant concept edges into lesson generation", async () => {
    const { app, db, store, systems } = await setup();
    const { course } = store.createCourse("Calculus");
    store.writeFirstSyllabus(course.id, null, {
      topics: [{ title: "Derivatives", summary: "Rates of change", reason: "Core", requestedByLearner: false, concepts: ["Derivatives"] }],
      known: [],
    });
    const [topic] = store.latestSyllabus(course.id)!.topics;

    const res = await app.request(`/api/courses/${course.id}/lessons`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ topicId: topic!.id }),
    });
    expect(res.status).toBe(201);
    const { lesson } = (await res.json()) as { lesson: { id: string } };
    await vi.waitFor(() => {
      const row = db.select().from(lessonsTable).where(eq(lessonsTable.id, lesson.id)).get();
      expect(row?.status).not.toBe("generating");
    });

    const lessonSystem = systems.find((s) => s.includes("writing one lesson of a course"));
    expect(lessonSystem).toBeDefined();
    expect(graphRows(lessonSystem)).toEqual([{ from: "Limits", to: "Derivatives", kind: "prerequisite" }]);
  });
});
