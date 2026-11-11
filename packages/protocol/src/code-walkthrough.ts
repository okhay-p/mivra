import { z } from "zod";
import { MAX_CODE_LINES, TraceCode, TraceVariable, codeLines } from "./algorithm-trace.js";

/**
 * code_walkthrough v1: a step-through illustration of code that isn't about a sequence, such as a plain
 * function or a React render (#98). The source stays fixed; each step highlights its lines and shows the
 * state and the output at that point, with an explanation.
 *
 * Every step is a complete snapshot: nothing carries over from the step before, so omitted or empty
 * `lines` highlight nothing, `variables: []` shows none and `output: ""` shows no output. Stepping back
 * shows exactly the earlier snapshot. The snapshots are the tutor's illustration, never a real run: the
 * code is inert text, and nothing is graded or recorded as evidence.
 */

export const MAX_WALKTHROUGH_STEPS = 200;
export const MAX_WALKTHROUGH_VARIABLES = 12;
export const MAX_WALKTHROUGH_OUTPUT = 4000;

export const CodeWalkthroughStep = z
  .object({
    explanation: z.string().trim().min(1).max(500).describe("What happens at this step and why, in one or two sentences."),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('Optional short name for the step, e.g. "Initial render", "Click handler", "Render 2".'),
    lines: z
      .array(z.number().int().positive())
      .max(MAX_CODE_LINES)
      .optional()
      .describe("The 1-based line numbers in code.source this step is at. Not carried over: omit or leave empty to highlight none."),
    variables: z
      .array(TraceVariable)
      .max(MAX_WALKTHROUGH_VARIABLES)
      .describe(
        'All the state visible at this step, each name once, e.g. "n", "render.count", "handler.count", "queued update". Not carried over: list everything that still applies, or [] for none. Values are plain text, numbers or booleans; write undefined, null or a short object as a string.',
      ),
    output: z
      .string()
      .max(MAX_WALKTHROUGH_OUTPUT)
      .describe(
        'Everything visible as output at this step, as plain text, e.g. printed lines or what the page shows ("Count: 0"). Not carried over: repeat earlier output that is still visible, or "" for none.',
      ),
  })
  .strict();

export const CodeWalkthroughSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    code: TraceCode.describe("The source shown on every step. It stays the same across steps."),
    steps: z.array(CodeWalkthroughStep).min(1).max(MAX_WALKTHROUGH_STEPS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const codeLength = codeLines(spec.code.source).length;
    spec.steps.forEach((step, i) => {
      step.lines?.forEach((line, j) => {
        if (line > codeLength) {
          ctx.addIssue({ code: "custom", path: ["steps", i, "lines", j], message: `line ${line} is outside the code (${codeLength} lines)` });
        }
      });
      const seen = new Set<string>();
      step.variables.forEach((variable, j) => {
        if (seen.has(variable.name)) {
          ctx.addIssue({ code: "custom", path: ["steps", i, "variables", j, "name"], message: `variable "${variable.name}" appears twice in this step` });
        }
        seen.add(variable.name);
      });
    });
  });

export type CodeWalkthroughSpec = z.infer<typeof CodeWalkthroughSpec>;
export type CodeWalkthroughStep = z.infer<typeof CodeWalkthroughStep>;
