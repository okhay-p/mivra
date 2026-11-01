import { z } from "zod";
import { splitMath } from "./math-text.js";

const REPAIR = String.raw`Wrap LaTeX commands in single-dollar math delimiters, with no spaces inside: $\displaystyle\sum_{i=1}^{n} i$. Put \displaystyle inside the dollars. For literal backslashes followed by two or more letters (such as C:\Users), use forward slashes, Unicode symbols such as ∖, or describe them in words; backticks do not escape artifact math. Correct the affected field and retry this tool call.`;

// Single-letter code escapes stay literal; longer literals such as C:\Users are still rejected.
export function checkMathText(value: unknown, path: (string | number)[], ctx: z.RefinementCtx) {
  if (typeof value === "string" && splitMath(value).some((piece) => "text" in piece && /\\[a-zA-Z]{2,}/.test(piece.text))) {
    ctx.addIssue({ code: "custom", path, message: REPAIR });
  }
}

/** Input-only refinements: stored v1 specs and public views must continue to accept old text. */
export function artifactMathInput<T extends z.ZodType>(schema: T, fields: string[], extra?: (spec: z.output<T>, ctx: z.RefinementCtx) => void) {
  return schema.superRefine((spec, ctx) => {
    const visit = (value: unknown, parts: string[], path: (string | number)[]) => {
      if (parts.length === 0) return checkMathText(value, path, ctx);
      const [key, ...rest] = parts;
      if (key === "*" && Array.isArray(value)) value.forEach((item, i) => visit(item, rest, [...path, i]));
      else if (value && typeof value === "object" && key !== undefined) visit((value as Record<string, unknown>)[key], rest, [...path, key]);
    };
    for (const field of fields) visit(spec, field.split("."), []);
    extra?.(spec, ctx);
  });
}
