import { useState } from "react";
import { submitMultipleChoice } from "../api.js";
import type { ArtifactProps } from "./ArtifactPart.js";

export function MultipleChoice({ view, replyInProgress, onUpdate }: ArtifactProps<"multiple_choice">) {
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
    setSubmitting(undefined);
    if (result.ok) onUpdate(result.view);
    else setError(result.error);
  };

  const optionClass = (i: number) => {
    if (!grade) return "mc-option";
    if (i === grade.correctOptionIndex) return "mc-option correct";
    if (i === chosen) return "mc-option incorrect";
    return "mc-option";
  };
  const optionMark = (i: number) => {
    if (!grade) return null;
    if (i === chosen) return grade.correct ? " ✓ Your answer, correct" : " ✗ Your answer, incorrect";
    if (i === grade.correctOptionIndex) return " ✓ Correct answer";
    return null;
  };

  return (
    <section className={answered ? "artifact mc answered" : "artifact mc"} aria-label={`Check: ${spec.concept}`}>
      <p className="mc-concept">Check · {spec.concept}</p>
      <p className="mc-question">{spec.question}</p>
      <div className="mc-options" role="group" aria-label="Options">
        {spec.options.map((option, i) => (
          <button
            key={i}
            type="button"
            className={optionClass(i)}
            disabled={disabled}
            aria-pressed={chosen === i || submitting === i}
            onClick={() => void answer(i)}
          >
            {option.text}
            {optionMark(i) && <span className="mc-mark">{optionMark(i)}</span>}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {!answered && replyInProgress && <p className="mc-hint">Answer once the reply finishes.</p>}
        {error && <p className="error">{error}</p>}
        {grade && (
          <div className="mc-result">
            <p className={grade.correct ? "mc-verdict correct" : "mc-verdict incorrect"}>
              {grade.correct ? "Correct!" : "Not quite."}
            </p>
            {grade.feedback && <p>{grade.feedback}</p>}
            <p>{grade.explanation}</p>
          </div>
        )}
      </div>
    </section>
  );
}
