import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ScrollableText, STEP_RULES, StepperControls, useStepper } from "./stepper.js";

/**
 * Reveals steps cumulatively. A step not yet revealed isn't in the page for anyone, and everyone reaches it the
 * same way: Next announces the new step through the live list, and Show all reveals the rest at once.
 */
export function WorkedSteps({ view }: ArtifactProps<"worked_steps">) {
  const { spec } = view;
  const stepper = useStepper(spec.steps.length);
  const { index, last, go } = stepper;
  const allShown = index === last;

  return (
    <Card role="region" aria-label={`Worked steps: ${spec.title}`} tabIndex={0} onKeyDown={stepper.onKeyDown} className="whitespace-normal">
      <CardHeader>
        <CardTitle className="font-heading text-base">
          <h3>
            <ScrollableText>
              <MathText text={spec.title} mode="math" />
            </ScrollableText>
          </h3>
        </CardTitle>
        <CardDescription>Worked steps</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {spec.goal && (
          <p className="text-sm">
            <ScrollableText>
              <span className="font-medium">Goal: </span>
              <MathText text={spec.goal} mode="math" />
            </ScrollableText>
          </p>
        )}
        <ol className="flex flex-col gap-3" aria-live="polite" aria-relevant="additions">
          {spec.steps.slice(0, index + 1).map((step, i) => (
            <li
              key={i}
              aria-current={i === index ? "step" : undefined}
              className={cn("flex min-w-0 flex-col gap-1", i === index ? STEP_RULES.current : STEP_RULES.other)}
              data-testid="worked-step"
            >
              {step.label && (
                <p className="text-muted-foreground text-xs font-medium">
                  <ScrollableText>
                    <MathText text={step.label} mode="math" />
                  </ScrollableText>
                </p>
              )}
              <div>
                <ScrollableText>
                  <MathText text={step.statement} mode="math" />
                </ScrollableText>
              </div>
              <p className="text-muted-foreground text-sm">
                <ScrollableText>
                  <MathText text={step.justification} mode="math" />
                </ScrollableText>
              </p>
            </li>
          ))}
        </ol>
        <StepperControls stepper={stepper}>
          {/* The same button either way, so it keeps focus when its label changes. */}
          <Button type="button" variant="ghost" size="sm" onClick={() => go(allShown ? 0 : last)}>
            {allShown ? "Start over" : "Show all"}
          </Button>
        </StepperControls>
      </CardContent>
    </Card>
  );
}
