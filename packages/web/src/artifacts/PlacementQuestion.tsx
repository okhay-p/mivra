import type { PlacementAnswer } from "@mivra/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { submitPlacement } from "../api.js";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";

type Choice = number | "unsure" | "skipped";
const toAnswer = (choice: Choice): PlacementAnswer =>
  choice === "unsure" ? { unsure: true } : choice === "skipped" ? { skipped: true } : { optionIndex: choice };

/**
 * One placement interview question (ADR-011). Answer chips, plus Not sure and Skip, which are always
 * offered. There is no confidence rating: asking for one breaks the flow.
 */
export function PlacementQuestion({ view, replyInProgress, onUpdate, onRefresh }: ArtifactProps<"placement_question">) {
  const { spec, latestAttempt } = view;
  const [submitting, setSubmitting] = useState<Choice>();
  const [error, setError] = useState<string>();

  const answered = latestAttempt !== undefined;
  const disabled = answered || replyInProgress || submitting !== undefined;
  const grade = latestAttempt?.grade;
  const answer = latestAttempt?.answer;
  const chosen = answer && "optionIndex" in answer ? answer.optionIndex : undefined;

  const submit = async (choice: Choice) => {
    if (disabled) return;
    setSubmitting(choice);
    setError(undefined);
    const result = await submitPlacement(view.id, toAnswer(choice));
    if (result.ok) {
      setSubmitting(undefined);
      return onUpdate(result.view);
    }
    setError(result.error);
    try {
      await onRefresh();
    } catch {
      // Keep the submit error; the learner can retry.
    } finally {
      setSubmitting(undefined);
    }
  };

  const optionResult = (i: number) => {
    if (!grade) return undefined;
    if (i === grade.correctOptionIndex) return "correct";
    return i === chosen ? "incorrect" : undefined;
  };

  const summary =
    grade?.result === "correct" ? "Correct." : grade?.result === "incorrect" ? "Not quite." : grade?.result === "unsure" ? "Marked as not sure." : "Skipped.";

  return (
    <Card role="region" aria-label={`Placement question: ${spec.concept}`} className="whitespace-normal">
      <CardHeader>
        <CardDescription>Placement · {spec.concept}</CardDescription>
        <CardTitle className="font-heading text-base">
          <MathText text={spec.question} mode="math" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Answers">
          {spec.options.map((option, i) => {
            const result = optionResult(i);
            return (
              <Button
                key={i}
                type="button"
                variant="outline"
                size="sm"
                data-result={result}
                aria-pressed={chosen === i}
                className={cn(
                  "h-auto max-w-full py-1.5 text-left font-normal whitespace-normal wrap-anywhere",
                  answered && "disabled:opacity-100",
                  submitting === i && "border-foreground dark:border-foreground",
                  result === "correct" && "border-success bg-success/10 dark:border-success dark:bg-success/15",
                  result === "incorrect" && "border-destructive bg-destructive/10 dark:border-destructive dark:bg-destructive/15",
                )}
                disabled={disabled}
                onClick={() => void submit(i)}
              >
                <MathText text={option.text} mode="math" />
              </Button>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={grade?.result === "unsure"}
            className={cn(answered && "disabled:opacity-100", grade?.result === "unsure" && "bg-muted")}
            disabled={disabled}
            onClick={() => void submit("unsure")}
          >
            Not sure
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={grade?.result === "skipped"}
            className={cn("text-muted-foreground", answered && "disabled:opacity-100", grade?.result === "skipped" && "bg-muted")}
            disabled={disabled}
            onClick={() => void submit("skipped")}
          >
            Skip
          </Button>
        </div>
        <div aria-live="polite" className="flex flex-col gap-1 text-sm">
          {!answered && replyInProgress && <p className="text-muted-foreground">Answer once the reply finishes.</p>}
          {error && <p className="text-destructive">{error}</p>}
          {grade && (
            <>
              <p
                className={cn(
                  "font-medium",
                  grade.result === "correct" ? "text-success" : grade.result === "incorrect" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {summary}
              </p>
              {grade.result !== "skipped" && (
                <p className="text-muted-foreground">
                  <MathText text={grade.explanation} mode="math" />
                </p>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
