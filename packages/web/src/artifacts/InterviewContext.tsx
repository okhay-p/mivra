import { MAX_INTERVIEW_CONTEXT_CHARS, type InterviewContextAnswer } from "@mivra/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitInterviewContext } from "../api.js";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader } from "./artifact-card.js";

/**
 * The placement interview's optional last question (#75): anything else the learner wants the tutor to know,
 * in their own words. Leaving it blank or skipping it completes the interview just the same. Not graded.
 */
export function InterviewContext({ view, replyInProgress, onUpdate, onRefresh }: ArtifactProps<"interview_context">) {
  const { spec, latestAttempt } = view;
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const fieldId = useId();

  const answered = latestAttempt !== undefined;
  const disabled = answered || replyInProgress || submitting;
  const written = latestAttempt?.grade.result === "answered" && "text" in latestAttempt.answer ? latestAttempt.answer.text : undefined;

  const submit = async (answer: InterviewContextAnswer) => {
    if (disabled) return;
    setSubmitting(true);
    setError(undefined);
    const result = await submitInterviewContext(view.id, answer);
    if (result.ok) {
      setSubmitting(false);
      return onUpdate(result.view);
    }
    setError(result.error);
    try {
      await onRefresh();
    } catch {
      // Keep the submit error; the learner can retry.
    } finally {
      setSubmitting(false);
    }
  };

  const text = draft.trim();

  return (
    <ArtifactCard role="region" aria-label="Anything else to add">
      <ArtifactHeader kind="Placement" aside="Optional" />
      <ArtifactBody className="gap-4">
        <label htmlFor={fieldId} className="font-heading text-[1.2rem] leading-snug font-medium text-pretty">
          <MathText text={spec.question} mode="math" />
        </label>
        {answered ? (
          written !== undefined ? (
            <p className="bg-sunken rounded-md px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere">{written}</p>
          ) : (
            <p className="text-muted-foreground text-sm font-medium">Skipped.</p>
          )
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (text) void submit({ text });
            }}
          >
            <Textarea
              id={fieldId}
              value={draft}
              maxLength={MAX_INTERVIEW_CONTEXT_CHARS}
              rows={3}
              placeholder="For example: I know the basics, but I want to go deep on one part of it."
              aria-describedby={`${fieldId}-help`}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={disabled || !text}>
                Send
              </Button>
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={disabled} onClick={() => void submit({ skipped: true })}>
                Skip
              </Button>
              <span id={`${fieldId}-help`} className="text-muted-foreground ml-auto text-xs">
                Fine to leave blank · {draft.length}/{MAX_INTERVIEW_CONTEXT_CHARS}
              </span>
            </div>
          </form>
        )}
        <div aria-live="polite" className="flex flex-col gap-1 text-sm">
          {!answered && replyInProgress && <p className="text-muted-foreground">Answer once the reply finishes.</p>}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      </ArtifactBody>
    </ArtifactCard>
  );
}
