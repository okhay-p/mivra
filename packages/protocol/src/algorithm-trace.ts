import { z } from "zod";

/**
 * algorithm_trace v1: a step-through view of an algorithm running over a sequence.
 * Each step can move labelled pointers, highlight index ranges, update variables and
 * replace the sequence (for swaps/sorts). Covers sliding window, two pointers, binary
 * search and simple sorts.
 */

const MAX_VALUES = 64;
const MAX_STEPS = 200;

const Label = z.string().trim().min(1).max(40);
const Cell = z.union([z.number(), z.string().max(24)]);
const Index = z.number().int().nonnegative();

export const TracePointer = z
  .object({
    name: Label.describe('Pointer label shown under the cell, e.g. "left", "right", "mid", "i".'),
    index: Index.describe("0-based index into values."),
  })
  .strict();

export const TraceRange = z
  .object({
    start: Index.describe("0-based start index, inclusive."),
    end: Index.describe("0-based end index, inclusive."),
    label: Label.optional().describe('Optional label, e.g. "window".'),
    tone: z
      .enum(["active", "done", "muted"])
      .optional()
      .describe("active = current focus, done = finished/sorted, muted = ruled out. Defaults to active."),
  })
  .strict();

export const TraceVariable = z
  .object({
    name: Label,
    value: z.union([z.number(), z.string().max(80), z.boolean()]),
  })
  .strict();

export const TraceStep = z
  .object({
    explanation: z.string().trim().min(1).max(500).describe("What happens in this step, in one or two sentences."),
    values: z
      .array(Cell)
      .min(1)
      .max(MAX_VALUES)
      .optional()
      .describe("The whole sequence after this step. Omit unless the values changed (e.g. a swap)."),
    pointers: z.array(TracePointer).max(8).optional(),
    ranges: z.array(TraceRange).max(8).optional(),
    variables: z.array(TraceVariable).max(12).optional().describe("Running state, e.g. current sum, best so far."),
  })
  .strict();

export const AlgorithmTraceSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    values: z.array(Cell).min(1).max(MAX_VALUES).describe("The input sequence before the first step."),
    steps: z.array(TraceStep).min(1).max(MAX_STEPS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // Every pointer and range must point inside the sequence as it is at that step.
    let length = spec.values.length;
    spec.steps.forEach((step, i) => {
      if (step.values) length = step.values.length;
      step.pointers?.forEach((p, j) => {
        if (p.index >= length) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "pointers", j, "index"],
            message: `index ${p.index} is outside the sequence (length ${length})`,
          });
        }
      });
      step.ranges?.forEach((r, j) => {
        if (r.end >= length || r.start > r.end) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "ranges", j],
            message: `range ${r.start}..${r.end} is invalid for a sequence of length ${length}`,
          });
        }
      });
    });
  });

export type AlgorithmTraceSpec = z.infer<typeof AlgorithmTraceSpec>;
export type TraceStep = z.infer<typeof TraceStep>;
