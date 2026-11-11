import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { submitMultipleChoice } from "../api.js";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, OptionKey } from "./artifact-card.js";

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
    <ArtifactCard role="region" aria-label={`Check: ${spec.concept}`}>
      <ArtifactHeader kind="Check" aside="Graded against an answer key">
        <span className="text-muted-foreground min-w-0 text-sm font-semibold wrap-anywhere">{spec.concept}</span>
      </ArtifactHeader>
      <ArtifactBody className="gap-4">
        <div data-slot="check-question" className="font-heading text-[1.2rem] leading-snug font-medium text-pretty">
          <MathText text={spec.question} mode="math" />
        </div>
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
                  "border-border-strong dark:border-border-strong bg-card dark:bg-card hover:bg-sunken dark:hover:bg-sunken h-auto flex-wrap justify-start gap-x-3 gap-y-1 rounded-[10px] px-3.5 py-2.5 text-left font-medium whitespace-normal",
                  answered && "disabled:opacity-100",
                  submitting === i && "border-foreground dark:border-foreground",
                  // The dark: variants beat the outline button's own dark border and background.
                  result === "correct" && "border-success bg-success/10 dark:border-success dark:bg-success/15",
                  result === "incorrect" && "border-destructive bg-destructive/10 dark:border-destructive dark:bg-destructive/15",
                )}
                disabled={disabled}
                onClick={() => void answer(i)}
              >
                <OptionKey index={i} />
                <span className="min-w-0 flex-[1_1_10rem] wrap-anywhere">
                  <MathText text={option.text} mode="math" />
                </span>
                {optionMark(i) && (
                  <span className={cn("shrink-0 pl-9 text-sm font-semibold sm:pl-0", result === "incorrect" ? "text-destructive" : "text-success")}>
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
            <Alert className="bg-sunken border-0 px-4 py-3">
              <AlertTitle className={cn("font-heading text-[1.15rem] font-medium", grade.correct ? "text-success" : "text-destructive")}>
                {grade.correct ? "Correct!" : "Not quite."}
              </AlertTitle>
              <AlertDescription className="text-foreground">
                {grade.feedback && (
                  <p>
                    <MathText text={grade.feedback} mode="math" />
                  </p>
                )}
                <p>
                  <MathText text={grade.explanation} mode="math" />
                </p>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </ArtifactBody>
    </ArtifactCard>
  );
}
