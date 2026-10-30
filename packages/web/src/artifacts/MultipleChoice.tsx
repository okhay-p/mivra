import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { submitMultipleChoice } from "../api.js";
import type { ArtifactProps } from "./ArtifactPart.js";

export function MultipleChoice({ view, replyInProgress, onUpdate, onRefresh }: ArtifactProps<"multiple_choice">) {
  const { spec, latestAttempt } = view;
  const [submitting, setSubmitting] = useState<number>();
  const [error, setError] = useState<string>();

  const answered = latestAttempt !== undefined;
  const disabled = answered || replyInProgress || submitting !== undefined;
  const chosen = latestAttempt?.answer.optionIndex;
  const grade = latestAttempt?.grade;

  const answer = async (optionIndex: number) => {
    if (disabled) return;
    setSubmitting(optionIndex);
    setError(undefined);
    const result = await submitMultipleChoice(view.id, optionIndex);
    if (result.ok) {
      setSubmitting(undefined);
      return onUpdate(result.view);
    }
    setError(result.error);
    // The answer may have been saved anyway (lost response, another tab); if so, show its grade.
    // Answering stays disabled until that's known.
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
  const optionMark = (i: number) => {
    if (!grade) return null;
    if (i === chosen) return grade.correct ? "✓ Your answer, correct" : "✗ Your answer, incorrect";
    if (i === grade.correctOptionIndex) return "✓ Correct answer";
    return null;
  };

  return (
    <Card role="region" aria-label={`Check: ${spec.concept}`} className="whitespace-normal">
      <CardHeader>
        <CardDescription>Check · {spec.concept}</CardDescription>
        <CardTitle className="font-heading text-base">{spec.question}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2" role="group" aria-label="Options">
          {spec.options.map((option, i) => {
            const result = optionResult(i);
            return (
              <Button
                key={i}
                type="button"
                variant="outline"
                data-result={result}
                className={cn(
                  "h-auto flex-wrap justify-between gap-x-3 gap-y-1 py-2 text-left font-normal whitespace-normal",
                  answered && "disabled:opacity-100",
                  submitting === i && "border-primary dark:border-primary",
                  // The dark: variants beat the outline button's own dark border and background.
                  result === "correct" && "border-success bg-success/10 dark:border-success dark:bg-success/15",
                  result === "incorrect" && "border-destructive bg-destructive/10 dark:border-destructive dark:bg-destructive/15",
                )}
                disabled={disabled}
                onClick={() => void answer(i)}
              >
                <span className="min-w-0 flex-[1_1_12rem] wrap-anywhere">{option.text}</span>
                {optionMark(i) && (
                  <span className={cn("shrink-0 text-xs font-medium", result === "incorrect" ? "text-destructive" : "text-success")}>
                    {optionMark(i)}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
        <div aria-live="polite" className="flex flex-col gap-2">
          {!answered && replyInProgress && <p className="text-muted-foreground text-sm">Answer once the reply finishes.</p>}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {grade && (
            <Alert className="bg-muted">
              <AlertTitle className={grade.correct ? "text-success" : "text-destructive"}>
                {grade.correct ? "Correct!" : "Not quite."}
              </AlertTitle>
              <AlertDescription className="text-foreground">
                {grade.feedback && <p>{grade.feedback}</p>}
                <p>{grade.explanation}</p>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
