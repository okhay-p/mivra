import { z } from "zod";

/**
 * multiple_choice v1: a comprehension check with exactly one correct option, graded by the
 * server without a model call (ADR-006). The full spec (with the answer) stays on the server;
 * the client gets the public view until the learner has answered.
 */

export const MultipleChoiceOption = z
  .object({
    text: z.string().trim().min(1).max(300),
    feedback: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Shown if the learner picks this option: why it is right or what misconception it reflects."),
  })
  .strict();

export const MultipleChoiceSpec = z
  .object({
    concept: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('Short label for the concept being checked, e.g. "sliding window invariant". Used to track progress.'),
    question: z.string().trim().min(1).max(1000),
    options: z.array(MultipleChoiceOption).min(2).max(6).describe("2-6 options with distinct text."),
    correctOptionIndex: z
      .number()
      .int()
      .nonnegative()
      .describe("0-based index of the single correct option; must be less than the number of options."),
    explanation: z.string().trim().min(1).max(1000).describe("Shown after answering: why the correct option is correct."),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.correctOptionIndex >= spec.options.length) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIndex"],
        message: "correctOptionIndex must point at one of the options",
      });
    }
    // Two identical options can't be told apart, but only one would be graded correct. Compare the
    // trimmed text exactly: case and inner spacing can be the point of a question ("A" vs "a",
    // "a b" vs "a  b"). NFC only merges Unicode spellings that render identically.
    const seen = new Map<string, number>();
    spec.options.forEach((option, i) => {
      const key = option.text.normalize("NFC");
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({ code: "custom", path: ["options", i, "text"], message: `duplicates option ${first}` });
      } else {
        seen.set(key, i);
      }
    });
  });

export type MultipleChoiceSpec = z.infer<typeof MultipleChoiceSpec>;

/** What the client sees before answering: no answer key, no feedback. */
export const MultipleChoicePublic = z
  .object({
    concept: z.string(),
    question: z.string(),
    options: z.array(z.object({ text: z.string() }).strict()),
  })
  .strict();

export type MultipleChoicePublic = z.infer<typeof MultipleChoicePublic>;

export function toMultipleChoicePublic(spec: MultipleChoiceSpec): MultipleChoicePublic {
  return {
    concept: spec.concept,
    question: spec.question,
    options: spec.options.map((o) => ({ text: o.text })),
  };
}

export const MultipleChoiceAnswer = z.object({ optionIndex: z.number().int().nonnegative() }).strict();
export type MultipleChoiceAnswer = z.infer<typeof MultipleChoiceAnswer>;

export const MultipleChoiceGrade = z
  .object({
    correct: z.boolean(),
    correctOptionIndex: z.number().int().nonnegative(),
    explanation: z.string(),
    feedback: z.string().optional(),
  })
  .strict();
export type MultipleChoiceGrade = z.infer<typeof MultipleChoiceGrade>;

/** Deterministic grader. Throws if the answer points outside the options. */
export function gradeMultipleChoice(spec: MultipleChoiceSpec, answer: MultipleChoiceAnswer): MultipleChoiceGrade {
  const chosen = spec.options[answer.optionIndex];
  if (!chosen) throw new RangeError(`optionIndex ${answer.optionIndex} is not one of the ${spec.options.length} options`);
  return {
    correct: answer.optionIndex === spec.correctOptionIndex,
    correctOptionIndex: spec.correctOptionIndex,
    explanation: spec.explanation,
    ...(chosen.feedback ? { feedback: chosen.feedback } : {}),
  };
}
