import { z } from "zod";

/**
 * algorithm_trace v1: a step-through view of an algorithm running over a sequence.
 * Each step can move labelled pointers, highlight index ranges, update variables and
 * replace the sequence (for swaps/sorts). Covers sliding window, two pointers, binary
 * search and simple sorts.
 *
 * A trace can also show the code it runs (`code`), with each step naming the 1-based source lines it
 * highlights (`lines`). Both are optional, so traces without code, including stored ones, stay valid.
 * The code is text only: it is never run, and renderers show it as inert monospaced text.
 *
 * State rules (renderers must follow them):
 * - `values` persists: a step without `values` shows the previous step's sequence.
 * - `pointers`, `ranges` and `variables` do not persist: each step lists all of its own,
 *   and omitting one means that step has none. So every step is fully described by itself
 *   plus the current sequence, and bounds can be checked step by step.
 */

const MAX_VALUES = 64;
const MAX_STEPS = 200;
export const MAX_CODE_LINES = 40;
export const MAX_CODE_LINE_LENGTH = 120;
export const MAX_CODE_CHARS = 4000;

/** A trace's source split into lines, as numbered from 1: line endings are normalised and one trailing newline is ignored. */
export function codeLines(source: string): string[] {
  return source.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

const Label = z.string().trim().min(1).max(40);
const Cell = z.union([z.number(), z.string().max(24)]);
const Index = z.number().int().nonnegative();

export const TracePointer = z
  .object({
    name: Label.describe('Pointer label shown under the cell, e.g. "left", "right", "mid", "i".'),
    index: Index.describe("0-based index into the sequence as it is at this step."),
  })
  .strict();

export const TraceRange = z
  .object({
    start: Index.describe("0-based start index, inclusive, within the sequence as it is at this step."),
    end: Index.describe("0-based end index, inclusive. Must be >= start and within the sequence."),
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

export const TraceCode = z
  .object({
    language: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .describe('The language the code is written in, e.g. "Python", "TypeScript", "Java" or "pseudocode". Shown as a label.'),
    source: z
      .string()
      .min(1)
      .max(MAX_CODE_CHARS)
      .describe(
        `The code, as plain text with newlines and its real indentation: at most ${MAX_CODE_LINES} lines of at most ${MAX_CODE_LINE_LENGTH} characters. Line 1 is the first line. No Markdown fences.`,
      ),
  })
  .strict()
  .superRefine((code, ctx) => {
    const lines = codeLines(code.source);
    if (lines.every((line) => line.trim() === "")) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "source has no code" });
    }
    if (lines.length > MAX_CODE_LINES) {
      ctx.addIssue({ code: "custom", path: ["source"], message: `source has ${lines.length} lines; at most ${MAX_CODE_LINES} are allowed` });
    }
    const long = lines.findIndex((line) => line.length > MAX_CODE_LINE_LENGTH);
    if (long >= 0) {
      ctx.addIssue({ code: "custom", path: ["source"], message: `line ${long + 1} is longer than ${MAX_CODE_LINE_LENGTH} characters` });
    }
  });

export const TraceStep = z
  .object({
    explanation: z.string().trim().min(1).max(500).describe("What happens in this step, in one or two sentences."),
    values: z
      .array(Cell)
      .min(1)
      .max(MAX_VALUES)
      .optional()
      .describe("The whole sequence after this step. Omit unless the values changed (e.g. a swap); omitted means unchanged."),
    pointers: z
      .array(TracePointer)
      .max(8)
      .optional()
      .describe("All pointers to show at this step. Not carried over from earlier steps: repeat any that still apply."),
    ranges: z
      .array(TraceRange)
      .max(8)
      .optional()
      .describe("All highlighted ranges at this step. Not carried over from earlier steps."),
    variables: z
      .array(TraceVariable)
      .max(12)
      .optional()
      .describe("All running state at this step, e.g. current sum, best so far. Not carried over from earlier steps."),
    lines: z
      .array(z.number().int().positive())
      .max(MAX_CODE_LINES)
      .optional()
      .describe(
        "Only with code: the 1-based line numbers in code.source this step is running, highlighted beside the values. Not carried over from earlier steps; omit or leave empty to highlight none.",
      ),
  })
  .strict();

export const AlgorithmTraceSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    values: z.array(Cell).min(1).max(MAX_VALUES).describe("The input sequence before the first step."),
    code: TraceCode.optional().describe(
      "Optional source code shown beside the values, with each step's `lines` highlighted. Include it only when the code itself is the point.",
    ),
    steps: z.array(TraceStep).min(1).max(MAX_STEPS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // Every pointer and range must point inside the sequence as it is at that step.
    let length = spec.values.length;
    const codeLength = spec.code ? codeLines(spec.code.source).length : 0;
    spec.steps.forEach((step, i) => {
      if (step.lines && !spec.code) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "lines"], message: "lines need code: add code, or remove lines" });
      } else {
        step.lines?.forEach((line, j) => {
          if (line > codeLength) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", i, "lines", j],
              message: `line ${line} is outside the code (${codeLength} lines)`,
            });
          }
        });
      }
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
export type TraceCode = z.infer<typeof TraceCode>;
