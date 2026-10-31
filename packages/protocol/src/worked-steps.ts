import { z } from "zod";

/**
 * worked_steps v1: a proof, induction or combinatorics working, revealed one step at a time.
 * Every step stays on screen once revealed, so later steps can be read against earlier ones.
 */

const MAX_STEPS = 50;

export const WorkedStep = z
  .object({
    label: z.string().trim().min(1).max(40).optional().describe('Optional heading for this part of the working, e.g. "Base case", "Inductive step".'),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe("What this step establishes, mostly as a formula in $...$. For large sums and fractions, start the formula with \\displaystyle; $$ is not available."),
    justification: z.string().trim().min(1).max(500).describe('Why it follows, e.g. "by the inductive hypothesis".'),
  })
  .strict();

export const WorkedStepsSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(500).optional().describe("Optional statement of what is being shown, e.g. the claim to prove."),
    steps: z.array(WorkedStep).min(1).max(MAX_STEPS),
  })
  .strict();

export type WorkedStepsSpec = z.infer<typeof WorkedStepsSpec>;
export type WorkedStep = z.infer<typeof WorkedStep>;
