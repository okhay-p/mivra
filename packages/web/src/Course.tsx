import { MAX_GOAL_CHARS, type CourseView, type KnownSource } from "@mivra/protocol";
import { ChevronDown, GraduationCap } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getCourse, startCourse } from "./api.js";

export interface StartedCourse {
  session: { id: string; title: string; updatedAt: string; courseId: string | null };
  goal: string;
}

/** The first screen: one question, which starts a course (ADR-011). */
export function StartCourseForm({ onStarted, onFreeChat }: { onStarted: (started: StartedCourse) => void; onFreeChat: () => void }) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = goal.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await startCourse(text);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onStarted({ session: result.value.session, goal: text });
  };

  return (
    <form onSubmit={submit} className="m-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <h2 className="font-heading text-center text-2xl font-semibold">What do you want to learn?</h2>
      <p className="text-muted-foreground text-center text-sm">
        Mivra asks a few quick questions to see what you already know, then plans a course of short lessons.
      </p>
      <div className="flex gap-2">
        <Input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={MAX_GOAL_CHARS}
          placeholder="e.g. Calculus for machine learning"
          aria-label="Learning goal"
          autoFocus
        />
        <Button type="submit" disabled={!goal.trim() || busy}>
          {busy ? "Starting…" : "Start"}
        </Button>
      </div>
      {error && <p className="text-destructive text-center text-sm">{error}</p>}
      <Button type="button" variant="link" className="text-muted-foreground self-center" onClick={onFreeChat}>
        Or just chat
      </Button>
    </form>
  );
}

const sourceLabel: Record<KnownSource, string> = { memory: "From memory", test: "From the test", guess: "Guessed" };

/** The course's goal, where it stands, and its syllabus once written. `version` changes reload it. */
export function CourseBar({ sessionId, version }: { sessionId: string; version: number }) {
  const [course, setCourse] = useState<CourseView>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    void getCourse(sessionId).then((result) => {
      if (current && result.ok) setCourse(result.value);
    });
    return () => {
      current = false;
    };
  }, [sessionId, version]);

  if (!course) return null;
  const syllabus = course.syllabus;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="bg-muted/40 border-b" aria-label="Course" role="region">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2 text-sm">
        <GraduationCap className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-medium">{course.goal}</span>
        <Badge variant="outline" className="shrink-0">
          {course.status === "interviewing" ? "Placement interview" : course.status === "complete" ? "Complete" : "In progress"}
        </Badge>
        {syllabus && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto shrink-0">
              Syllabus · {syllabus.topics.length} topics
              <ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />
            </Button>
          </CollapsibleTrigger>
        )}
      </div>
      {syllabus && (
        <CollapsibleContent>
          <div className="mx-auto flex max-h-[50svh] max-w-3xl flex-col gap-4 overflow-y-auto px-4 pb-4">
            <ol className="flex flex-col gap-3" aria-label="Syllabus topics">
              {syllabus.topics.map((topic, i) => (
                <li key={topic.id} className="flex gap-3">
                  <span className="text-muted-foreground w-5 shrink-0 text-right tabular-nums">{i + 1}.</span>
                  <div className="min-w-0">
                    <p className="font-medium">
                      {topic.title}
                      {topic.requestedByLearner && (
                        <Badge variant="secondary" className="ml-2 align-middle">
                          You asked for this
                        </Badge>
                      )}
                    </p>
                    <p className="text-muted-foreground">{topic.summary}</p>
                    <p className="text-muted-foreground text-xs italic">Why: {topic.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
            {syllabus.known.length > 0 && (
              <div>
                <p className="mb-1 font-medium">What Mivra thinks you know</p>
                <ul className="flex flex-col gap-1" aria-label="What Mivra thinks you know">
                  {syllabus.known.map((k, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2">
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
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
