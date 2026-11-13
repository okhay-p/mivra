import type { ArtifactView, MilestoneCaseResult, MilestoneDisputeRequest, MilestoneReview } from "@mivra/protocol";
import { Check, Copy, X } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { disputeMilestone } from "../api.js";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, ArtifactTitle } from "./artifact-card.js";

/** The course a milestone belongs to, for the `mivra link` command it shows. Set by the lesson page. */
export const MilestoneCourseContext = createContext<string | undefined>(undefined);

const ERROR_TEXT: Record<NonNullable<MilestoneCaseResult["error"]>, string> = {
  timeout: "Stopped: it took longer than the time limit.",
  output_limit: "Stopped: it printed more than the output limit.",
  start_failed: "Your command couldn't start.",
  no_run_output_command: "This case runs your program's output: set a command for that with --run-output.",
};

function Block({ label, text, tone }: { label: string; text: string; tone?: "error" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground font-mono text-[0.6875rem] tracking-[0.06em] uppercase">{label}</span>
      <pre
        className={cn(
          "bg-sunken max-h-48 min-w-0 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere",
          tone === "error" && "text-destructive",
        )}
      >
        {text === "" ? <span className="text-muted-foreground italic">(nothing)</span> : text}
      </pre>
    </div>
  );
}

/** A command to copy into a terminal. */
function Command({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-sunken flex min-w-0 items-center gap-2 rounded-md py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre">{text}</code>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={copied ? `Copied: ${label}` : `Copy: ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Without clipboard access the command can still be selected and copied by hand.
          }
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}

type MilestoneView = Extract<ArtifactView, { kind: "project_milestone" }>;

const CRITERIA = [
  ["noHardCodedOutputs", "Computes its output"],
  ["concept", "Shows the milestone's concept"],
  ["quality", "Code quality"],
] as const;

const OUTCOME_TEXT: Record<MilestoneView["spec"]["disputes"][number]["outcome"], string> = {
  kept: "kept",
  withdrawn: "withdrawn",
  corrected: "corrected",
  upheld: "upheld",
  overturned: "overturned",
};

/**
 * A learner's dispute: what's wrong, sent to the tutor, who looks again. Waits for the tutor's decision, which can
 * take a minute, then shows the milestone as it now is.
 */
function DisputeForm({ artifactId, target, label, onDone, onCancel }: { artifactId: string; target: { target: "case"; caseIndex: number } | { target: "review" }; label: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const result = await disputeMilestone(artifactId, { ...target, reason: reason.trim() } as MilestoneDisputeRequest);
    setBusy(false);
    if (result.ok) await onDone();
    else setError(result.error);
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() && !busy) void submit();
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Textarea id={id} value={reason} maxLength={2000} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="What's wrong with it? The tutor will look again." />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
          {busy && <Spinner />}
          {busy ? "The tutor is looking again…" : "Send dispute"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The review's verdict on the latest check: a model's judgement, shown as one, kept apart from the tests. */
function ReviewVerdict({ review, createdAt }: { review: MilestoneReview; createdAt: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid="milestone-review" data-approved={review.approved}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("font-medium", review.approved ? "text-success" : "text-destructive")}>{review.approved ? "Approved" : "Changes requested"}</span>
        <Badge variant="outline">Judged by a model</Badge>
        <span className="text-muted-foreground text-xs">
          {review.model}, <time dateTime={createdAt}>{new Date(createdAt).toLocaleString()}</time>
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {CRITERIA.map(([key, label]) => (
          <li key={key} className="flex gap-2 text-sm">
            {review[key].passed ? <Check className="text-success mt-0.5 size-4 shrink-0" aria-hidden /> : <X className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />}
            <span className="min-w-0">
              <span className="font-medium">{label}</span>
              <span className="sr-only">{review[key].passed ? ": passed" : ": not yet"}</span> <span className="text-muted-foreground">{review[key].note}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="text-[0.95rem]">
        <MathText text={review.summary} mode="block" />
      </div>
      {review.suggestions.length > 0 && (
        <ul className="text-muted-foreground list-disc pl-5 text-sm">
          {review.suggestions.map((suggestion, i) => (
            <li key={i}>{suggestion}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A project course's milestone (ADR-016): what to build, the exact output, and its cases. The learner builds it in their
 * own repository and checks it there with `mivra check`; each check replaces the result shown here. Passing needs every
 * case and the code review's approval; the learner can dispute a case or a verdict.
 */
export function ProjectMilestone({ view, onRefresh }: ArtifactProps<"project_milestone">) {
  const { spec, latestAttempt, latestReview } = view;
  const courseId = useContext(MilestoneCourseContext);
  const titleId = useId();
  const [disputing, setDisputing] = useState<number | "review">();
  const grade = latestAttempt?.grade;
  const results = latestAttempt?.answer.results;
  const runsOutput = spec.cases.some((c) => c.compare === "run_output");
  const reviewOnly = spec.checkType === "review";
  // Each case's latest result, by its place in the cases: withdrawn ones don't run, so results skip them.
  const byCase = new Map((grade?.cases ?? []).map((c, i) => [c.case ?? i, { passed: c.passed, result: results?.[i] }]));
  const sent = latestAttempt?.answer.files ?? [];
  // Reloaded rather than kept as a local copy: later checks keep arriving from the server, and must replace it.
  const disputed = async () => {
    setDisputing(undefined);
    await onRefresh();
  };

  return (
    <ArtifactCard role="region" aria-labelledby={titleId} data-testid="project-milestone">
      <ArtifactHeader kind="Milestone" aside={reviewOnly ? "Checked by a code review" : "Checked in your repository"}>
        <ArtifactTitle id={titleId} text={spec.title} />
      </ArtifactHeader>
      <ArtifactBody className="@container gap-4">
        <div className="text-[0.95rem]" data-testid="milestone-spec">
          <MathText text={spec.spec} mode="block" />
        </div>
        <section className="flex flex-col gap-1.5" aria-label="Output format">
          <h4 className="text-sm font-medium">Output format</h4>
          <div className="text-[0.95rem]">
            <MathText text={spec.outputFormat} mode="block" />
          </div>
        </section>
        {spec.reviewFocus && (
          <section className="flex flex-col gap-1.5" aria-label="What the review looks for">
            <h4 className="text-sm font-medium">What the review looks for</h4>
            <div className="text-[0.95rem]">
              <MathText text={spec.reviewFocus} mode="block" />
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2" aria-label="Check it">
          <h4 className="text-sm font-medium">Check it</h4>
          <p className="text-muted-foreground text-sm">
            In your project's folder, link it to this course once, with the command that runs your program. <code className="font-mono text-xs">{"{input}"}</code> becomes the path to a file holding each case's input, which also comes on stdin. Then check whenever you like.
          </p>
          {courseId && <Command label="link command" text={`mivra link ${courseId} --run "./your-program {input}"${runsOutput ? ' --run-output "./run-it {output}"' : ""}`} />}
          <Command label="check command" text="mivra check" />
          <p className="text-muted-foreground text-sm">
            Each check also sends the files that changed since your last passed milestone to a code review, which must approve too. It follows your <code className="font-mono text-xs">.gitignore</code> and never sends <code className="font-mono text-xs">.env</code> files or keys; <code className="font-mono text-xs">mivra check --dry-run</code> lists exactly what it would send.
          </p>
          {runsOutput && (
            <p className="text-muted-foreground text-sm">
              Some cases run what your program prints: <code className="font-mono text-xs">{"{output}"}</code> in your run-output command becomes the path to a file holding it.
            </p>
          )}
        </section>

        <div aria-live="polite" data-testid="milestone-status">
          {grade ? (
            <Alert className="bg-sunken border-0 px-4 py-3">
              <AlertTitle className={cn("font-heading text-[1.15rem] font-medium", view.passed ? "text-success" : "text-destructive")}>{view.passed ? "Milestone passed." : "Not yet."}</AlertTitle>
              <AlertDescription className="text-foreground">
                Latest check{grade.total > 0 ? `: ${grade.passed} of ${grade.total} ${grade.total === 1 ? "case" : "cases"} passed` : ""},{" "}
                <time dateTime={latestAttempt.createdAt}>{new Date(latestAttempt.createdAt).toLocaleString()}</time>.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-muted-foreground text-sm">Not checked yet.</p>
          )}
        </div>

        {latestAttempt && (
          <section className="flex flex-col gap-2 rounded-lg border px-3 py-2.5" aria-label="Code review">
            <h4 className="text-sm font-medium">Code review</h4>
            {latestReview ? (
              <>
                <ReviewVerdict review={latestReview.review} createdAt={latestReview.createdAt} />
                {!latestReview.review.approved &&
                  (disputing === "review" ? (
                    <DisputeForm artifactId={view.id} target={{ target: "review" }} label="Why is the verdict wrong?" onDone={disputed} onCancel={() => setDisputing(undefined)} />
                  ) : (
                    <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setDisputing("review")}>
                      Dispute this verdict
                    </Button>
                  ))}
              </>
            ) : (
              <p className="text-muted-foreground text-sm" data-testid="milestone-review-missing">
                {!grade?.correct
                  ? "The review runs once every case passes."
                  : latestAttempt.answer.source === "none"
                    ? "Nothing was sent to review: run mivra check in a git repository."
                    : sent.length === 0
                      ? "No changed files were sent to review."
                      : "The review of the latest check didn't finish. Run mivra check again."}
              </p>
            )}
            {sent.length > 0 && (
              <p className="text-muted-foreground text-xs wrap-anywhere">
                Sent for review: {sent.slice(0, 12).join(", ")}
                {sent.length > 12 ? ` and ${sent.length - 12} more` : ""}.
              </p>
            )}
          </section>
        )}

        {spec.cases.length > 0 && (
          <ol className="flex flex-col gap-2" aria-label="Test cases">
            {spec.cases.map((testCase, i) => {
              const found = byCase.get(i);
              const passed = testCase.withdrawn ? undefined : found?.passed;
              const result = found?.result;
              return (
                <li
                  key={i}
                  className={cn("flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5", testCase.withdrawn && "opacity-60")}
                  data-testid="milestone-case"
                  data-result={testCase.withdrawn ? "withdrawn" : passed === undefined ? "pending" : passed ? "passed" : "failed"}
                >
                  <div className="flex items-center gap-2 text-sm">
                    {passed === true && <Check className="text-success size-4 shrink-0" aria-hidden />}
                    {passed === false && <X className="text-destructive size-4 shrink-0" aria-hidden />}
                    <span className={cn("min-w-0 font-medium wrap-anywhere", testCase.withdrawn && "line-through")}>{testCase.name}</span>
                    {passed !== undefined && <span className="sr-only">{passed ? " passed" : " failed"}</span>}
                    {testCase.withdrawn && <Badge variant="outline">Withdrawn</Badge>}
                    <span className="ml-auto flex items-center gap-2">
                      {testCase.compare === "run_output" && <span className="text-muted-foreground text-xs">runs your output</span>}
                      {!testCase.withdrawn && disputing !== i && (
                        <Button type="button" size="xs" variant="ghost" onClick={() => setDisputing(i)} aria-label={`Dispute case: ${testCase.name}`}>
                          Dispute
                        </Button>
                      )}
                    </span>
                  </div>
                  {disputing === i && <DisputeForm artifactId={view.id} target={{ target: "case", caseIndex: i }} label={`Why is "${testCase.name}" wrong?`} onDone={disputed} onCancel={() => setDisputing(undefined)} />}
                  <div className="grid gap-2 @[34rem]:grid-cols-2">
                    <Block label="Input" text={testCase.input} />
                    <Block label={testCase.compare === "run_output" ? "Running your output prints" : "Expected output"} text={testCase.expected} />
                  </div>
                  {passed === false && result && (
                    <>
                      {result.error ? (
                        <p className="text-destructive text-sm">{ERROR_TEXT[result.error]}</p>
                      ) : (
                        <>
                          {result.exitCode !== 0 && <p className="text-destructive text-sm">Exited with code {result.exitCode}.</p>}
                          <Block label="Your program printed" text={result.truncated ? `${result.stdout}\n… (cut short)` : result.stdout} />
                        </>
                      )}
                      {result.stderr && <Block label="stderr" text={result.stderr} tone="error" />}
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {spec.disputes.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="Disputes">
            <h4 className="text-sm font-medium">Disputes</h4>
            <ul className="flex flex-col gap-2" data-testid="milestone-disputes">
              {spec.disputes.map((d) => (
                <li key={d.id} className="bg-sunken flex flex-col gap-1 rounded-md px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{d.target === "case" ? `Case "${d.caseName ?? ""}"` : "Review verdict"}</span>: {OUTCOME_TEXT[d.outcome]}
                  </span>
                  <span className="text-muted-foreground">You said: {d.reason}</span>
                  <span>{d.explanation}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </ArtifactBody>
    </ArtifactCard>
  );
}
