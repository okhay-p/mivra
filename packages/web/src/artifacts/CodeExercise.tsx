import { MAX_SUBMITTED_CODE_CHARS, casePassed, type CodeExerciseAnswer, type ExerciseCaseRun, type ExercisePublicCase } from "@mivra/protocol";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { submitCodeExercise } from "../api.js";
import { caseInput, createRunnerFor, RunStopped, type CaseRunner } from "../exercise-runner.js";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, ArtifactTitle } from "./artifact-card.js";

type Results = (ExerciseCaseRun | undefined)[];
type Running = { mode: "run" | "submit"; done: number; total: number; starting?: boolean };

const LANGUAGE_NAMES = { javascript: "JavaScript", python: "Python" } as const;

const draftKey = (id: string) => `mivra.exercise.${id}`;
function readDraft(id: string): string | undefined {
  try {
    return localStorage.getItem(draftKey(id)) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeDraft(id: string, code: string | undefined) {
  try {
    if (code === undefined) localStorage.removeItem(draftKey(id));
    else localStorage.setItem(draftKey(id), code);
  } catch {
    // A draft is a convenience; without storage the code just isn't kept across reloads.
  }
}

/** How a call case reads: `sum([1, 2, 3])`. */
function callText(functionName: string | undefined, args: string) {
  try {
    const parsed: unknown = JSON.parse(args);
    if (Array.isArray(parsed)) return `${functionName ?? "f"}(${parsed.map((a) => JSON.stringify(a)).join(", ")})`;
  } catch {
    // Shown as given.
  }
  return `${functionName ?? "f"}(…${args})`;
}

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

function CaseResult({
  index,
  testCase,
  run,
  passed,
  functionName,
  stderrLabel,
}: {
  index: number;
  testCase: ExercisePublicCase;
  run: ExerciseCaseRun | undefined;
  passed: boolean | undefined;
  functionName: string | undefined;
  stderrLabel: string;
}) {
  const name = `Case ${index + 1}${testCase.hidden ? " (hidden)" : ""}`;
  const status = passed === undefined ? "Not run" : passed ? "Passed" : "Failed";
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5",
        passed === true && "border-success bg-success/5",
        passed === false && "border-destructive bg-destructive/5",
      )}
      data-testid="exercise-case"
      data-result={passed === undefined ? "pending" : passed ? "passed" : "failed"}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{name}</span>
        <span className={cn("ml-auto text-sm font-semibold", passed === true ? "text-success" : passed === false ? "text-destructive" : "text-muted-foreground")}>
          {passed === true ? "✓ " : passed === false ? "✗ " : ""}
          {status}
        </span>
      </div>
      {!testCase.hidden && (
        <div className="grid min-w-0 gap-2 @lg:grid-cols-2">
          {testCase.kind === "call" ? <Block label="Call" text={callText(functionName, testCase.args)} /> : <Block label="Input" text={testCase.stdin} />}
          {testCase.expected &&
            ("stdout" in testCase.expected ? <Block label="Expected output" text={testCase.expected.stdout} /> : <Block label="Expected return value" text={testCase.expected.returned} />)}
          {run && run.error !== undefined && <Block label="Error" text={run.error} tone="error" />}
          {run && run.error === undefined && testCase.kind === "call" && <Block label="Returned" text={run.returned ?? ""} />}
          {run && (testCase.kind === "stdio" || run.stdout !== "") && <Block label={testCase.kind === "stdio" ? "Your output" : "Printed"} text={run.stdout} />}
          {run?.stderr && <Block label={stderrLabel} text={run.stderr} />}
        </div>
      )}
      {testCase.hidden && run?.error !== undefined && passed === false && <p className="text-destructive text-sm wrap-anywhere">{run.error}</p>}
    </li>
  );
}

/**
 * A JavaScript or Python exercise (ADR-016): the learner edits the code, runs the visible cases as often as they
 * like, and submits once. Code runs in a Web Worker, QuickJS for JavaScript (exercise.worker.ts) and Pyodide for
 * Python (python-exercise.worker.ts), one case at a time, with a Stop button and a hard time limit that
 * terminates the worker. Python takes a while to load, so it starts loading when the editor gets focus. Submit runs every case, hidden ones included, and the
 * server grades what they produced. After submitting, the saved code and results come back with the view, so a
 * reload shows them without running anything.
 */
export function CodeExercise({ view, replyInProgress, onUpdate, onRefresh }: ArtifactProps<"code_exercise">) {
  const { spec, latestAttempt } = view;
  const submitted = latestAttempt !== undefined;
  const titleId = useId();
  const editorId = useId();
  const hintId = useId();
  const [code, setCode] = useState(() => latestAttempt?.answer.code ?? readDraft(view.id) ?? spec.starterCode);
  const [results, setResults] = useState<Results>(() => latestAttempt?.answer.results ?? []);
  const [running, setRunning] = useState<Running>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const runner = useRef<CaseRunner>(undefined);
  const escaped = useRef(false);
  const python = spec.language === "python";
  const indent = python ? "    " : "  ";
  const getRunner = () => (runner.current ??= createRunnerFor(spec.language));

  useEffect(() => () => runner.current?.dispose(), []);
  // A graded view (from this tab or a refresh) replaces whatever ran locally.
  useEffect(() => {
    if (!latestAttempt) return;
    setCode(latestAttempt.answer.code);
    setResults(latestAttempt.answer.results);
  }, [latestAttempt]);

  const grade = latestAttempt?.grade;
  const passed = useMemo(
    () =>
      spec.cases.map((testCase, i) => {
        if (grade) return grade.cases[i]?.passed;
        const run = results[i];
        return run && testCase.expected ? casePassed(testCase.expected, run) : undefined;
      }),
    [spec.cases, results, grade],
  );

  const edit = (next: string) => {
    setCode(next);
    writeDraft(view.id, next === spec.starterCode ? undefined : next);
  };

  const runCases = async (mode: Running["mode"], indices: number[]): Promise<Results | undefined> => {
    const active = getRunner();
    const next: Results = mode === "submit" ? [] : [...results];
    for (const i of indices) next[i] = undefined;
    setResults(next);
    setError(undefined);
    setStatus(undefined);
    try {
      for (const [done, i] of indices.entries()) {
        setRunning({ mode, done, total: indices.length, starting: true });
        next[i] = await active.run(code, spec.functionName, caseInput(spec.cases[i]!), {
          onStart: () => setRunning({ mode, done, total: indices.length }),
        });
        setResults([...next]);
      }
      return next;
    } catch (e) {
      if (!(e instanceof RunStopped)) throw e;
      setStatus(mode === "submit" ? "Stopped. Nothing was submitted." : "Stopped.");
      return undefined;
    } finally {
      setRunning(undefined);
    }
  };

  const visible = spec.cases.flatMap((c, i) => (c.hidden ? [] : [i]));
  const run = async () => {
    const ran = await runCases("run", visible);
    if (!ran) return;
    const count = visible.filter((i) => ran[i] && spec.cases[i]!.expected && casePassed(spec.cases[i]!.expected!, ran[i]!)).length;
    setStatus(`${count} of ${visible.length} visible ${visible.length === 1 ? "case" : "cases"} passed.`);
  };

  const submit = async () => {
    if (code.length > MAX_SUBMITTED_CODE_CHARS) {
      setError(`The code is too long to submit (over ${MAX_SUBMITTED_CODE_CHARS.toLocaleString("en-US")} characters).`);
      return;
    }
    const ran = await runCases(
      "submit",
      spec.cases.map((_, i) => i),
    );
    if (!ran) return;
    setRunning({ mode: "submit", done: spec.cases.length, total: spec.cases.length });
    const answer: CodeExerciseAnswer = { code, results: ran as ExerciseCaseRun[] };
    const result = await submitCodeExercise(view.id, answer);
    if (result.ok) {
      setRunning(undefined);
      writeDraft(view.id, undefined);
      return onUpdate(result.view);
    }
    setError(result.error);
    // It may have been saved anyway (a lost response, another tab); if so, show that.
    try {
      await onRefresh();
    } catch {
      // Keep the error; the learner can submit again.
    } finally {
      setRunning(undefined);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab indents, except straight after Escape, so the keyboard can still leave the editor.
    if (e.key === "Escape") {
      escaped.current = true;
      return;
    }
    const wasEscaped = escaped.current;
    escaped.current = false;
    if (e.key !== "Tab" || e.shiftKey || wasEscaped || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const box = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = box;
    const next = `${code.slice(0, start)}${indent}${code.slice(end)}`;
    edit(next);
    requestAnimationFrame(() => box.setSelectionRange(start + indent.length, start + indent.length));
  };

  const busy = running !== undefined;
  const submitBlocked = submitted || replyInProgress || busy;
  const progress = running
    ? running.done >= running.total
      ? "Submitting…"
      : running.starting && python
        ? "Starting Python… (the first run takes a few seconds)"
        : `Running case ${running.done + 1} of ${running.total}…`
    : undefined;

  return (
    <ArtifactCard role="region" aria-labelledby={titleId}>
      <ArtifactHeader kind="Exercise" aside={`${LANGUAGE_NAMES[spec.language]} · runs in your browser`}>
        <ArtifactTitle id={titleId} text={spec.title} />
      </ArtifactHeader>
      <ArtifactBody className="@container gap-4">
        <div className="text-[0.95rem]" data-testid="exercise-instructions">
          <MathText text={spec.instructions} mode="block" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={editorId} className="text-sm font-medium">
            {submitted ? "Your submitted code" : "Your code"}
          </label>
          <Textarea
            id={editorId}
            aria-describedby={hintId}
            value={code}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (python && !submitted) getRunner().warm();
            }}
            readOnly={submitted || busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            className={cn("bg-card dark:bg-card min-h-40 resize-y overflow-x-auto font-mono text-xs leading-relaxed md:text-xs", python ? "[tab-size:4]" : "[tab-size:2]")}
            data-testid="exercise-editor"
          />
          <p id={hintId} className="text-muted-foreground text-xs">
            {spec.functionName
              ? `Define ${spec.functionName} at the top level. `
              : python
                ? "Read input with input() or sys.stdin, and print with print(). "
                : "Read input with readLine() or stdin, and print with console.log. "}
            {!submitted && "Tab indents; press Escape then Tab to leave the editor."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!submitted && (
            <>
              <Button type="button" variant="outline" onClick={() => void run()} disabled={busy}>
                Run
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={submitBlocked}>
                Submit
              </Button>
            </>
          )}
          {busy && running.done < running.total && (
            <Button type="button" variant="destructive" onClick={() => runner.current?.stop()}>
              Stop
            </Button>
          )}
          {!submitted && !busy && code !== spec.starterCode && (
            <Button type="button" variant="ghost" onClick={() => edit(spec.starterCode)}>
              Reset code
            </Button>
          )}
        </div>
        <div aria-live="polite" className="flex flex-col gap-2" data-testid="exercise-status">
          {progress && <p className="text-muted-foreground text-sm">{progress}</p>}
          {!progress && status && <p className="text-sm">{status}</p>}
          {!submitted && replyInProgress && <p className="text-muted-foreground text-sm">Submit once the reply finishes. You can run your code now.</p>}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {grade && (
            <Alert className="bg-sunken border-0 px-4 py-3">
              <AlertTitle className={cn("font-heading text-[1.15rem] font-medium", grade.correct ? "text-success" : "text-destructive")}>
                {grade.correct ? "All cases passed!" : "Not quite."}
              </AlertTitle>
              <AlertDescription className="text-foreground">
                {grade.passed} of {grade.total} {grade.total === 1 ? "case" : "cases"} passed{spec.cases.some((c) => c.hidden) ? ", hidden ones included" : ""}.
              </AlertDescription>
            </Alert>
          )}
        </div>
        <ol className="flex flex-col gap-2" aria-label="Test cases">
          {spec.cases.map((testCase, i) => (
            <CaseResult
              key={i}
              index={i}
              testCase={testCase}
              run={results[i]}
              passed={passed[i]}
              functionName={spec.functionName}
              stderrLabel={python ? "stderr" : "console.error / warn"}
            />
          ))}
        </ol>
      </ArtifactBody>
    </ArtifactCard>
  );
}
