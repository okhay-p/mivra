import { codeLines } from "@mivra/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, ArtifactTitle } from "./artifact-card.js";
import { CodePane } from "./CodePane.js";
import { ScrollableText, StepperControls, useStepper } from "./stepper.js";

/** Output up to this long is read out with the step; longer output is only summarised, so a step isn't a wall of speech. */
const SPOKEN_OUTPUT_CHARS = 200;

/**
 * The step's output as inert monospaced text, whitespace kept. Long output scrolls inside the pane, which is a tab
 * stop only while it overflows; its arrow keys then scroll rather than step, like the code pane's.
 */
function OutputPane({ output }: { output: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ x: false, y: false });
  const [focused, setFocused] = useState(false);
  const measure = () => {
    const el = box.current;
    if (!el) return;
    const next = { x: el.scrollWidth > el.clientWidth, y: el.scrollHeight > el.clientHeight };
    setOverflow((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(box.current!);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, []);
  const scrolls = overflow.x || overflow.y;

  return (
    <div className="flex min-w-0 flex-col rounded-md border" data-testid="walkthrough-output">
      <div className="text-muted-foreground border-b px-3 py-1 font-mono text-xs">Output</div>
      <div
        ref={box}
        role="region"
        aria-label={`Output${scrolls ? ", scrolls" : ""}`}
        className="max-h-72 min-w-0 overflow-auto px-3 py-2"
        data-testid="output-scroll"
        tabIndex={scrolls ? 0 : focused ? -1 : undefined}
        onFocus={() => setFocused(true)}
        onBlur={(e) => setFocused(document.activeElement === e.currentTarget)}
        onKeyDown={(e: KeyboardEvent) => {
          if (overflow.x && (e.key === "ArrowLeft" || e.key === "ArrowRight")) e.stopPropagation();
        }}
      >
        {output === "" ? (
          <p className="text-muted-foreground text-xs italic">No output yet</p>
        ) : (
          <pre className="w-max min-w-full font-mono text-xs leading-relaxed whitespace-pre [tab-size:4]" data-testid="output-text">
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

export function CodeWalkthrough({ view }: ArtifactProps<"code_walkthrough">) {
  const { spec } = view;
  const stepper = useStepper(spec.steps.length);
  const titleId = useId();
  const kindId = useId();
  const step = spec.steps[stepper.index]!;
  const source = codeLines(spec.code.source);
  // Lines are checked server-side; a line outside the code is skipped rather than misdrawn.
  const lines = (step.lines ?? []).filter((line) => line >= 1 && line <= source.length);
  const outputLines = step.output === "" ? 0 : codeLines(step.output).length;

  return (
    <ArtifactCard role="region" aria-labelledby={`${titleId} ${kindId}`} tabIndex={0} onKeyDown={stepper.onKeyDown}>
      <ArtifactHeader kind="Illustrated walkthrough" kindId={kindId}>
        <ArtifactTitle id={titleId} text={spec.title} />
      </ArtifactHeader>
      <ArtifactBody>
        {/* Source on the left and state and output on the right when the card is wide enough; stacked when it isn't. */}
        <div className="@container">
          <div className="grid gap-3 @xl:grid-cols-2">
            <CodePane code={spec.code} lines={lines} />
            <div className="flex min-w-0 flex-col gap-3">
              <section className="flex min-w-0 flex-col rounded-md border" aria-label="Variables" data-testid="walkthrough-variables">
                <div className="text-muted-foreground border-b px-3 py-1 font-mono text-xs" aria-hidden="true">
                  Variables
                </div>
                <div className="px-3 py-2">
                  {step.variables.length === 0 ? (
                    <p className="text-muted-foreground text-xs italic">No variables at this step</p>
                  ) : (
                    <dl className="flex flex-col gap-1 font-mono text-xs">
                      {step.variables.map((v) => (
                        <div key={v.name} className="flex min-w-0 gap-1.5 wrap-anywhere" data-testid="walkthrough-variable">
                          <dt className="min-w-0">{v.name}</dt>
                          <dd className="min-w-0">= {String(v.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </section>
              <OutputPane output={step.output} />
            </div>
          </div>
        </div>
        {/*
          Read whole on every step: the step number always changes, so a repeated explanation is still announced. Only
          the highlighted lines are read, never the whole code; long output is summarised and stays in its pane.
        */}
        <div aria-live="polite" aria-atomic="true" data-testid="walkthrough-status" className="flex flex-col gap-1">
          <span className="sr-only">
            Step {stepper.index + 1} of {stepper.last + 1}.{" "}
          </span>
          {step.label && (
            <span className="text-muted-foreground font-mono text-xs" data-testid="walkthrough-label">
              {step.label}
              <span className="sr-only">.</span>
            </span>
          )}
          <ScrollableText>
            <MathText text={step.explanation} mode="math" />
          </ScrollableText>
          <span className="sr-only">
            {lines.map((line) => ` Code line ${line}: ${source[line - 1]!.trim() || "blank"}.`)}
            {step.variables.length === 0 ? " No variables." : step.variables.map((v) => ` ${v.name} = ${String(v.value)}.`)}
            {step.output === ""
              ? " No output yet."
              : step.output.length <= SPOKEN_OUTPUT_CHARS
                ? ` Output: ${step.output}`
                : ` Output: ${outputLines} ${outputLines === 1 ? "line" : "lines"}, in the output pane.`}
          </span>
        </div>
      </ArtifactBody>
      <StepperControls stepper={stepper} play />
    </ArtifactCard>
  );
}
