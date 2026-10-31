import { z } from "zod";

/** Memory entries are the model's inferences about the learner, kept apart from graded evidence (ADR-009). */

export const MemoryKind = z.enum(["goal", "preference", "misconception"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

const MemoryText = z.string().trim().min(1).max(300);

/** The input of the remember tool. Source, timestamps and basis are set by the server, not the model. */
export const RememberInput = z
  .object({
    kind: MemoryKind.describe("goal = what they want to learn or do; preference = how they like to learn; misconception = something they believe that is wrong."),
    text: MemoryText.describe("One short sentence about the learner. Never include the answer to a check they haven't answered."),
    concept: z.string().trim().min(1).max(80).optional().describe("Required for a misconception: the concept it is about. Use the exact name from the check or from their record, so it can be linked to their answers."),
    replaces: z.string().min(1).optional().describe("The id of a known memory this one corrects or updates."),
  })
  .strict()
  .superRefine((input, ctx) => {
    // Without a concept a misconception can't be linked to a wrong answer (ADR-009).
    if (input.kind === "misconception" && !input.concept) {
      ctx.addIssue({ code: "custom", path: ["concept"], message: "A misconception needs a concept" });
    }
  });
export type RememberInput = z.infer<typeof RememberInput>;

/** How a memory is supported: a graded wrong answer, or only something said in chat. */
export const MemoryBasis = z.enum(["wrong_answer", "chat"]);
export type MemoryBasis = z.infer<typeof MemoryBasis>;

/** A memory as the learner sees it in the memory panel. */
export const MemoryView = z
  .object({
    id: z.string(),
    kind: MemoryKind,
    text: z.string(),
    concept: z.string().nullable(),
    basis: MemoryBasis,
    createdAt: z.string().datetime(),
    editedAt: z.string().datetime().nullable(),
  })
  .strict();
export type MemoryView = z.infer<typeof MemoryView>;

export const MemoryEdit = z.object({ text: MemoryText }).strict();
