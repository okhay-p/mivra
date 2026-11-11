import { useId } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, ArtifactTitle } from "./artifact-card.js";
import { ScrollableText, STEP_NUMBERS, StepperControls, useStepper } from "./stepper.js";

/**
 * Reveals steps cumulatively. A step not yet revealed isn't in the page for anyone, and everyone reaches it the
 * same way: Next adds the new step, and Show all reveals the rest at once. Whichever way the position changes, one
 * live region announces the step that's now current; the earlier ones stay in the list to read.
 */
export function WorkedSteps({ view }: ArtifactProps<"worked_steps">) {
  const { spec } = view;
  const stepper = useStepper(spec.steps.length);
  const { index, last, go } = stepper;
  const allShown = index === last;
  const current = spec.steps[index];
  const titleId = useId();
  const kindId = useId();

  return (
    <ArtifactCard role="region" aria-labelledby={`${titleId} ${kindId}`} tabIndex={0} onKeyDown={stepper.onKeyDown}>
      <ArtifactHeader kind={"Worked steps"} kindId={kindId}>
        <ArtifactTitle id={titleId} text={spec.title} />
      </ArtifactHeader>
      <ArtifactBody>
        {spec.goal && (
          <p className="bg-sunken rounded-lg px-3.5 py-2.5 leading-normal">
            <ScrollableText>
              <span className="font-semibold">Goal: </span>
              <MathText text={spec.goal} mode="math" />
            </ScrollableText>
          </p>
        )}
        <ol className="flex flex-col">
          {spec.steps.slice(0, index + 1).map((step, i) => (
            <li
              key={i}
              aria-current={i === index ? "step" : undefined}
              className="group relative flex min-w-0 flex-col gap-0.5 border-t py-2.5 pl-9 first:border-t-0 first:pt-0.5 last:pb-0"
              data-testid="worked-step"
            >
              {/* The list already numbers its items for screen readers. */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-2.5 left-0 grid size-6 place-items-center rounded-full font-mono text-[0.7rem] font-medium group-first:top-0.5",
                  i === index ? STEP_NUMBERS.current : STEP_NUMBERS.other,
                )}
                data-testid="worked-step-number"
              >
                {i + 1}
              </span>
              {step.label && (
                <p className="text-muted-foreground font-mono text-[0.6875rem] font-medium tracking-[0.06em] uppercase">
                  <ScrollableText>
                    <MathText text={step.label} mode="math" />
                  </ScrollableText>
                </p>
              )}
              <div className="font-heading text-[1.0625rem] leading-normal">
                <ScrollableText>
                  <MathText text={step.statement} mode="math" />
                </ScrollableText>
              </div>
              <p className="text-muted-foreground text-sm leading-snug">
                <ScrollableText>
                  <MathText text={step.justification} mode="math" />
                </ScrollableText>
              </p>
            </li>
          ))}
        </ol>
        <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="worked-status">
          Step {index + 1} of {last + 1}.{" "}
          {current?.label && (
            <>
              <MathText text={current.label} mode="math" />.{" "}
            </>
          )}
          {current && <MathText text={current.statement} mode="math" />} {current && <MathText text={current.justification} mode="math" />}
        </div>
      </ArtifactBody>
      <StepperControls stepper={stepper}>
        {/* The same button either way, so it keeps focus when its label changes. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground decoration-border-strong underline underline-offset-4 hover:bg-transparent dark:hover:bg-transparent"
          onClick={() => go(allShown ? 0 : last)}
        >
          {allShown ? "Start over" : "Show all"}
        </Button>
      </StepperControls>
    </ArtifactCard>
  );
}
