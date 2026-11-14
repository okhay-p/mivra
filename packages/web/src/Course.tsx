import { MAX_GOAL_CHARS, type CourseKind, type CourseView, type KnownSource } from "@mivra/protocol";
import { ChevronDown, GraduationCap } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { startCourse } from "./api.js";
import { ModelPicker, useModelPicker } from "./ModelPicker.js";
import { EYEBROW } from "./paper.js";

export interface StartedCourse {
  session: { id: string; title: string; updatedAt: string; courseId: string | null };
  goal: string;
}

/** The first screen: one question, which starts a course (ADR-011). */
export function StartCourseForm({ onStarted, onFreeChat }: { onStarted: (started: StartedCourse) => void; onFreeChat: () => void }) {
  const goalId = useId();
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState<CourseKind>("lessons");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The selection is app-wide (ADR-012): the one chosen here writes the syllabus and teaches the course.
  const modelPicker = useModelPicker();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = goal.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await startCourse(text, kind);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onStarted({ session: result.value.session, goal: text });
  };

  return (
    <form onSubmit={submit} className="m-auto flex w-full max-w-xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="font-heading text-[2rem] leading-[1.08] font-normal tracking-[-0.024em] text-balance">What do you want to learn?</h2>
        <FieldDescription id={`${goalId}-description`} className="text-center text-[0.95rem]">
          Mivra asks a few quick questions to see what you already know, then plans a course of short lessons.
        </FieldDescription>
      </div>
      <Field data-invalid={Boolean(error)} className="bg-card border-border-strong shadow-paper rounded-xl border p-4 sm:p-5">
        <FieldLabel htmlFor={goalId} className={EYEBROW}>
          Learning goal
        </FieldLabel>
        <div className="flex gap-2 max-[480px]:flex-col">
          <Input
            id={goalId}
            aria-describedby={`${goalId}-description${error ? ` ${goalId}-error` : ""}`}
            aria-invalid={Boolean(error)}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            maxLength={MAX_GOAL_CHARS}
            placeholder="e.g. Calculus for machine learning"
            className="bg-card dark:bg-card h-10 text-base md:text-base"
            autoFocus
          />
          <Button type="submit" className="h-10 px-5" disabled={!goal.trim() || busy}>
            {busy && <Spinner aria-hidden="true" />}
            {busy ? "Starting…" : "Start"}
          </Button>
        </div>
        {error && <FieldError id={`${goalId}-error`} role="alert">{error}</FieldError>}
        <div className="flex items-start gap-2.5 pt-1">
          <Checkbox
            id={`${goalId}-project`}
            aria-describedby={`${goalId}-project-description`}
            checked={kind === "project"}
            onCheckedChange={(checked) => setKind(checked === true ? "project" : "lessons")}
            disabled={busy}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5">
            <FieldLabel htmlFor={`${goalId}-project`} className="font-normal">
              Build it as a project in my own repository
            </FieldLabel>
            <FieldDescription id={`${goalId}-project-description`} className="text-[0.8125rem]">
              Milestones instead of lessons, in any language you have installed, each checked with <code className="font-mono text-xs">mivra check</code>.
            </FieldDescription>
          </div>
        </div>
      </Field>
      <div className="flex justify-center">
        <ModelPicker state={modelPicker} disabled={busy} />
      </div>
      <Button type="button" variant="link" className="text-muted-foreground self-center" onClick={onFreeChat}>
        Or just chat
      </Button>
    </form>
  );
}

const sourceLabel: Record<KnownSource, string> = { memory: "From memory", test: "From the test", guess: "Guessed" };

/**
 * Where the course stands, and its syllabus once written. The page header carries the course's title; the goal the
 * learner typed shows only inside the syllabus, labelled as such, so it never reads as a second title (#133).
 */
export function CourseBar({ course, children, onUndo }: { course: CourseView; children?: ReactNode; onUndo?: () => Promise<string | undefined> }) {
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string>();
  const syllabus = course.syllabus;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="bg-sunken/60 shrink-0 border-b" aria-label="Course" role="region">
      <div className="mx-auto flex max-w-3xl items-center gap-x-2 gap-y-1 px-4 py-2 text-sm max-sm:flex-wrap">
        <GraduationCap className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <Badge variant="outline" className="border-border-strong bg-card shrink-0 font-mono text-[0.6875rem] font-medium tracking-[0.06em] uppercase">
          {course.status === "interviewing" ? "Placement interview" : course.status === "complete" ? "Complete" : "In progress"}
        </Badge>
        {course.kind === "project" && (
          <Badge variant="outline" className="border-border-strong bg-card shrink-0 font-mono text-[0.6875rem] font-medium tracking-[0.06em] uppercase">
            Project
          </Badge>
        )}
        {syllabus && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto shrink-0">
              Syllabus · {syllabus.topics.length} {course.kind === "project" ? "milestones" : "topics"}
              <ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />
            </Button>
          </CollapsibleTrigger>
        )}
        {children && <div className={cn("flex shrink-0 gap-2", !syllabus && "ml-auto")}>{children}</div>}
      </div>
      {syllabus?.canUndo && (
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-4 pb-2 text-sm" role="status">
          <span>
            Mivra changed the plan: {syllabus.reason}
          </span>
          {onUndo && (
            <Button
              variant="outline"
              size="xs"
              disabled={undoing}
              onClick={async () => {
                setUndoing(true);
                setUndoError(await onUndo());
                setUndoing(false);
              }}
            >
              Undo
            </Button>
          )}
          {undoError && <span className="text-destructive">{undoError}</span>}
        </div>
      )}
      {syllabus && (
        <CollapsibleContent>
          {/* The panel's own border frames the scroll area, so its lower edge stays visible however far the topics
              scroll, and the chat below never reads as part of the syllabus (#106). */}
          <div className="mx-auto max-w-3xl px-4 pt-1 pb-4">
            <div
              className="bg-card border-border-strong shadow-paper focus-visible:ring-ring/50 flex max-h-[50svh] flex-col gap-4 overflow-y-auto overscroll-contain rounded-xl border px-4 py-3 outline-none focus-visible:ring-[3px]"
              role="region"
              aria-label="Syllabus"
              // It scrolls, so the keyboard can reach it.
              tabIndex={0}
            >
              <p className="text-muted-foreground wrap-anywhere">
                <span className="text-foreground font-medium">Your goal:</span> {course.goal}
              </p>
              {syllabus.reason && syllabus.version > 1 && (
                <p className="text-muted-foreground" role="status">
                  Version {syllabus.version}
                  {syllabus.source === "adaptive" ? " (changed by Mivra)" : ""}: {syllabus.reason}
                </p>
              )}
              <ol className="flex flex-col" aria-label="Syllabus topics">
                {syllabus.topics.map((topic, i) => (
                  <li
                    key={topic.id}
                    className={cn("flex gap-3 border-t py-3 first:border-t-0", syllabus.changedTopicIds.includes(topic.id) && "bg-sunken -mx-4 px-4")}
                  >
                    {/* The list numbers its items for screen readers. */}
                    <span aria-hidden="true" className="bg-sunken text-muted-foreground ring-border-strong mt-0.5 grid size-6 shrink-0 place-items-center rounded-full font-mono text-[0.7rem] font-medium ring-1 ring-inset">
                      {i + 1}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5 wrap-anywhere">
                      <p className="font-heading text-[1.0625rem] leading-snug font-medium">
                        {topic.title}
                        {syllabus.changedTopicIds.includes(topic.id) && (
                          <Badge variant="secondary" className="ml-2 align-middle">
                            Changed in v{syllabus.version}
                          </Badge>
                        )}
                        {topic.requestedByLearner && (
                          <Badge variant="secondary" className="ml-2 align-middle">
                            You asked for this
                          </Badge>
                        )}
                      </p>
                      <p className="text-muted-foreground">{topic.summary}</p>
                      <p className="text-muted-foreground text-[0.8125rem] italic">Why: {topic.reason}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {syllabus.known.length > 0 && (
                <div className="border-t pt-3">
                  <p className={cn(EYEBROW, "mb-2")}>What Mivra thinks you know</p>
                  <ul className="flex flex-col" aria-label="What Mivra thinks you know">
                    {syllabus.known.map((k, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 border-t py-1.5 first:border-t-0 wrap-anywhere">
                        <span>{k.concept}</span>
                        <Badge variant="outline" className="text-xs">
                          {sourceLabel[k.source]}
                        </Badge>
                        <span className="text-muted-foreground">{k.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
