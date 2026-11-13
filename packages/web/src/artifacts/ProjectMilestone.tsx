import type { MilestoneCaseResult } from "@mivra/protocol";
import { Check, Copy, X } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

/**
 * A project course's milestone (ADR-016): what to build, the exact output, and its cases. The learner builds it in their
 * own repository and checks it there with `mivra check`; each check replaces the result shown here.
 */
export function ProjectMilestone({ view }: ArtifactProps<"project_milestone">) {
  const { spec, latestAttempt } = view;
  const courseId = useContext(MilestoneCourseContext);
  const titleId = useId();
  const grade = latestAttempt?.grade;
  const results = latestAttempt?.answer.results;
  const runsOutput = spec.cases.some((c) => c.compare === "run_output");

  return (
    <ArtifactCard role="region" aria-labelledby={titleId} data-testid="project-milestone">
      <ArtifactHeader kind="Milestone" aside="Checked in your repository">
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

        <section className="flex flex-col gap-2" aria-label="Check it">
          <h4 className="text-sm font-medium">Check it</h4>
          <p className="text-muted-foreground text-sm">
            In your project's folder, link it to this course once, with the command that runs your program. <code className="font-mono text-xs">{"{input}"}</code> becomes the path to a file holding each case's input, which also comes on stdin. Then check whenever you like.
          </p>
          {courseId && <Command label="link command" text={`mivra link ${courseId} --run "./your-program {input}"${runsOutput ? ' --run-output "./run-it {output}"' : ""}`} />}
          <Command label="check command" text="mivra check" />
          {runsOutput && (
            <p className="text-muted-foreground text-sm">
              Some cases run what your program prints: <code className="font-mono text-xs">{"{output}"}</code> in your run-output command becomes the path to a file holding it.
            </p>
          )}
        </section>

        <div aria-live="polite" data-testid="milestone-status">
          {grade ? (
            <Alert className="bg-sunken border-0 px-4 py-3">
              <AlertTitle className={cn("font-heading text-[1.15rem] font-medium", grade.correct ? "text-success" : "text-destructive")}>
                {grade.correct ? "Every case passes." : "Not yet."}
              </AlertTitle>
              <AlertDescription className="text-foreground">
                Latest check: {grade.passed} of {grade.total} {grade.total === 1 ? "case" : "cases"} passed,{" "}
                <time dateTime={latestAttempt.createdAt}>{new Date(latestAttempt.createdAt).toLocaleString()}</time>.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-muted-foreground text-sm">Not checked yet.</p>
          )}
        </div>

        <ol className="flex flex-col gap-2" aria-label="Test cases">
          {spec.cases.map((testCase, i) => {
            const passed = grade?.cases[i]?.passed;
            const result = results?.[i];
            return (
              <li
                key={i}
                className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5"
                data-testid="milestone-case"
                data-result={passed === undefined ? "pending" : passed ? "passed" : "failed"}
              >
                <div className="flex items-center gap-2 text-sm">
                  {passed === true && <Check className="text-success size-4 shrink-0" aria-hidden />}
                  {passed === false && <X className="text-destructive size-4 shrink-0" aria-hidden />}
                  <span className="min-w-0 font-medium wrap-anywhere">{testCase.name}</span>
                  {passed !== undefined && <span className="sr-only">{passed ? " passed" : " failed"}</span>}
                  {testCase.compare === "run_output" && <span className="text-muted-foreground ml-auto text-xs">runs your output</span>}
                </div>
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
      </ArtifactBody>
    </ArtifactCard>
  );
}
