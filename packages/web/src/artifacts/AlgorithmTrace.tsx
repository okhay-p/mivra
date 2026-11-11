import { codeLines, type AlgorithmTraceSpec } from "@mivra/protocol";
import { useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, ArtifactTitle } from "./artifact-card.js";
import { CodePane } from "./CodePane.js";
import { ScrollableText, STEP_TONES, StepperControls, useStepper, type StepTone } from "./stepper.js";

/** What a range's tone means, which is otherwise only visible. The default tone needs no words. */
const RANGE_TONE_WORDS: Record<StepTone, string> = { active: "", done: ", done", muted: ", ruled out" };

/**
 * What to draw at a step, following the spec's state rules: `values` persists from the latest step
 * that set it; pointers, ranges and variables belong to that step only.
 */
export function traceStateAt(spec: AlgorithmTraceSpec, index: number) {
  let values = spec.values;
  for (const step of spec.steps.slice(0, index + 1)) {
    if (step.values) values = step.values;
  }
  const step = spec.steps[index];
  return {
    values,
    explanation: step?.explanation ?? "",
    pointers: step?.pointers ?? [],
    ranges: step?.ranges ?? [],
    variables: step?.variables ?? [],
    lines: step?.lines ?? [],
  };
}

/** What a step changed in the sequence, in words: going by what was on show, so it also holds when stepping back. */
export function traceValueChanges(from: AlgorithmTraceSpec["values"], to: AlgorithmTraceSpec["values"]) {
  if (from.length !== to.length) return ` The sequence is now ${to.map(String).join(", ")}.`;
  return to.flatMap((value, i) => (value === from[i] ? [] : [` Index ${i} is now ${String(value)}.`])).join("");
}

export function AlgorithmTrace({ view }: ArtifactProps<"algorithm_trace">) {
  const { spec } = view;
  const stepper = useStepper(spec.steps.length);
  const titleId = useId();
  const kindId = useId();

  const state = traceStateAt(spec, stepper.index);
  // Kept until the step changes, so a re-render at the same step doesn't change what the live region says.
  const shown = useRef({ index: stepper.index, from: state.values });
  if (shown.current.index !== stepper.index) shown.current = { index: stepper.index, from: traceStateAt(spec, shown.current.index).values };
  const n = state.values.length;
  // Bounds are checked server-side; still skip anything outside the sequence rather than misdraw it.
  const ranges = state.ranges.filter((r) => r.start <= r.end && r.end < n);
  const pointers = state.pointers.filter((p) => p.index < n);
  // Lines are checked server-side too; a line outside the code is skipped, like a pointer outside the sequence.
  const source = spec.code ? codeLines(spec.code.source) : [];
  const lines = state.lines.filter((line) => line >= 1 && line <= source.length);
  const toneAt = (i: number): StepTone | undefined => {
    const range = ranges.find((r) => r.start <= i && i <= r.end);
    return range ? (range.tone ?? "active") : undefined;
  };

  // The values, variables and live region: alone in the card, or beside the code.
  const body = (
    <>
      {/* The grid hides this from screen readers; what each step points at is in the live region below. */}
      <p className="sr-only" data-testid="trace-description">
        Values: {state.values.map((v, i) => `index ${i}: ${String(v)}`).join(", ")}
      </p>
      <ScrollableText label="Values, scrolls sideways" className="pb-1">
        <span aria-hidden="true" className="inline-grid w-max gap-1 wrap-normal" style={{ gridTemplateColumns: `repeat(${n}, minmax(2.5rem, max-content))` }}>
          {ranges.map((r, i) => (
            <span
              key={`range-${i}`}
              className={cn("min-h-5 rounded-sm px-1 text-center text-xs font-medium", STEP_TONES[r.tone ?? "active"])}
              style={{ gridColumn: `${r.start + 1} / ${r.end + 2}`, gridRow: i + 1 }}
              data-testid="trace-range"
            >
              {r.label ?? " "}
            </span>
          ))}
          {state.values.map((value, i) => {
            const tone = toneAt(i);
            return (
              <span
                key={`cell-${i}`}
                className={cn(
                  "bg-card border-border-strong relative grid h-11 place-items-center rounded-md border px-2 font-mono text-[0.95rem]",
                  tone && STEP_TONES[tone],
                )}
                style={{ gridColumn: i + 1, gridRow: ranges.length + 1 }}
                data-testid="trace-cell"
              >
                {String(value)}
                <span className="text-muted-foreground absolute right-1 bottom-0 text-[0.6rem]">{i}</span>
              </span>
            );
          })}
          {Array.from({ length: n }, (_, i) => {
            const names = pointers.filter((p) => p.index === i).map((p) => p.name);
            return names.length ? (
              <span
                key={`pointers-${i}`}
                className="text-foreground text-center font-mono text-xs font-medium"
                style={{ gridColumn: i + 1, gridRow: ranges.length + 2 }}
                data-testid="trace-pointer"
              >
                ↑ {names.join(", ")}
              </span>
            ) : null;
          })}
        </span>
      </ScrollableText>
      {state.variables.length > 0 && (
        <dl className="flex flex-wrap gap-2" aria-hidden="true">
          {state.variables.map((v, i) => (
            <div key={i} className="border-border-strong bg-card flex max-w-full min-w-0 gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs wrap-anywhere">
              <dt className="min-w-0">{v.name}</dt>
              <dd className="min-w-0">= {String(v.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {/*
        Always in the page and read whole. The step number changes every time, so two steps with the same
        explanation are still announced, along with what's otherwise only drawn.
      */}
      <div aria-live="polite" aria-atomic="true" data-testid="trace-status">
        <span className="sr-only">
          Step {stepper.index + 1} of {stepper.last + 1}.{" "}
        </span>
        <ScrollableText>
          <MathText text={state.explanation} mode="math" />
        </ScrollableText>
        <span className="sr-only">
          {traceValueChanges(shown.current.from, state.values)}
          {pointers.map((p) => ` ${p.name} points to index ${p.index}, value ${String(state.values[p.index])}.`)}
          {ranges.map((r) => ` ${r.label ? `${r.label} covers` : "Highlighted:"} indices ${r.start} through ${r.end}${RANGE_TONE_WORDS[r.tone ?? "active"]}.`)}
          {state.variables.map((v) => ` ${v.name} = ${String(v.value)}.`)}
          {lines.map((line) => ` Code line ${line}: ${source[line - 1]!.trim() || "blank"}.`)}
        </span>
      </div>
    </>
  );

  return (
    <ArtifactCard role="region" aria-labelledby={`${titleId} ${kindId}`} tabIndex={0} onKeyDown={stepper.onKeyDown}>
      <ArtifactHeader kind="Algorithm trace" kindId={kindId}>
        <ArtifactTitle id={titleId} text={spec.title} />
      </ArtifactHeader>
      <ArtifactBody>
        {spec.code ? (
          // Beside the values when the card is wide enough, above them when it isn't.
          <div className="@container">
            <div className="grid gap-3 @xl:grid-cols-2">
              <CodePane code={spec.code} lines={lines} />
              <div className="flex min-w-0 flex-col gap-3">{body}</div>
            </div>
          </div>
        ) : (
          body
        )}
      </ArtifactBody>
      <StepperControls stepper={stepper} play />
    </ArtifactCard>
  );
}
