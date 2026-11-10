import { z } from "zod";
import { MemoryText } from "./memory.js";

/**
 * Distilling imported notes into the knowledge graph (ADR-014): concepts, edges between them, and memories drawn from
 * notes. The model reads a group of notes and proposes all three through one tool; the server validates every item,
 * since the notes are hostile input (ADR-010).
 */

/** A note in the group being read, by the short reference the prompt gives it (`n1`, `n2`, ...). */
const NoteRef = z.string().regex(/^n\d{1,3}$/);
const ConceptName = z.string().trim().min(1).max(80);

export const MAX_PROPOSED_CONCEPTS = 30;
export const MAX_PROPOSED_EDGES = 40;
export const MAX_PROPOSED_MEMORIES = 30;

export const ConceptEdgeKind = z.enum(["prerequisite", "related"]);
export type ConceptEdgeKind = z.infer<typeof ConceptEdgeKind>;

/** The input of the record_from_notes tool. Every list is required, so an empty call is rejected. */
export const RecordFromNotesInput = z
  .object({
    concepts: z
      .array(
        z
          .object({
            name: ConceptName.describe("A name from <existing_concepts> or <vault_tags> when one fits. Otherwise a new name, written as it appears in the notes."),
            notes: z.array(NoteRef).min(1).max(20).describe("The refs of the notes that cover it."),
          })
          .strict(),
      )
      .max(MAX_PROPOSED_CONCEPTS),
    edges: z
      .array(
        z
          .object({
            from: ConceptName,
            to: ConceptName,
            kind: ConceptEdgeKind.describe("prerequisite = from must be understood before to; related = they're closely linked."),
            note: NoteRef.describe("The ref of the note that shows this link."),
          })
          .strict(),
      )
      .max(MAX_PROPOSED_EDGES)
      .describe("Edges between concepts named in this call or in <existing_concepts>."),
    memories: z
      .array(
        z
          .object({
            kind: z.enum(["known", "goal", "misconception"]).describe("known = the notes cover this concept; goal = a goal the notes state; misconception = a wrong belief the notes state."),
            text: MemoryText.describe("One short sentence about the learner."),
            concept: ConceptName.optional().describe("Required for known and misconception: a concept named in this call or in <existing_concepts>."),
            note: NoteRef.describe("The ref of the note it comes from."),
          })
          .strict(),
      )
      .max(MAX_PROPOSED_MEMORIES),
  })
  .strict();
export type RecordFromNotesInput = z.infer<typeof RecordFromNotesInput>;

export const DistillationStatus = z.enum(["idle", "queued", "running", "cancelled", "failed"]);
export type DistillationStatus = z.infer<typeof DistillationStatus>;

/**
 * Where distilling an import's notes stands. `pendingNotes` are notes not yet distilled at their current text; the
 * group counts describe the current or last run in this server process.
 */
export const DistillationView = z
  .object({
    status: DistillationStatus,
    pendingNotes: z.number().int(),
    groups: z.number().int(),
    groupsDone: z.number().int(),
    error: z.string().nullable(),
    /** Concepts and memories drawn from this import's notes so far. */
    concepts: z.number().int(),
    memories: z.number().int(),
  })
  .strict();
export type DistillationView = z.infer<typeof DistillationView>;

/** Every concept drawn from notes and the edges between them, each with the notes it came from. */
export const ConceptGraph = z
  .object({
    concepts: z.array(z.object({ id: z.string(), name: z.string(), notes: z.array(z.string()) }).strict()),
    edges: z.array(z.object({ from: z.string(), to: z.string(), kind: ConceptEdgeKind, notes: z.array(z.string()) }).strict()),
  })
  .strict();
export type ConceptGraph = z.infer<typeof ConceptGraph>;
