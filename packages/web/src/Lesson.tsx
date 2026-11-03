import type { ArtifactView, CourseLessonsView, LessonView } from "@mivra/protocol";
import { Check, CircleDashed, HelpCircle, Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { finishLesson, getLesson, retryLesson } from "./api.js";
import { ArtifactPart } from "./artifacts/ArtifactPart.js";
import { mergeViews } from "./chat-artifacts.js";
import { MathText } from "./MathText.js";

/**
 * Follows a lesson on the server: loads it, then keeps asking for the next change, which the server
 * holds until something does change. Sections appear as soon as they are written (ADR-011).
 */
export function useLesson(lessonId: string) {
  const [lesson, setLesson] = useState<LessonView>();
  const [error, setError] = useState<string>();
  const revision = useRef<string | undefined>(undefined);

  const apply = useCallback((value: { lesson: LessonView; revision: string }) => {
    revision.current = value.revision;
    setLesson(value.lesson);
    setError(undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    revision.current = undefined;
    setLesson(undefined);
    void (async () => {
      let failures = 0;
      while (!controller.signal.aborted) {
        const result = await getLesson(lessonId, revision.current, controller.signal);
        if (controller.signal.aborted) return;
        if (result.ok) {
          failures = 0;
          apply(result.value);
          // A finished lesson is frozen: nothing more will change.
          if (result.value.lesson.status === "finished") return;
        } else {
          setError(result.error);
          await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * 2 ** failures++)));
        }
      }
    })();
    return () => controller.abort();
  }, [lessonId, apply]);

  return { lesson, error, apply };
}

/** The syllabus as a list of topics, each marked with where its lesson stands. */
export function TopicList({
  lessons,
  selectedId,
  onSelect,
}: {
  lessons: CourseLessonsView;
  selectedId: string | undefined;
  onSelect: (lessonId: string) => void;
}) {
  return (
    <nav aria-label="Lessons">
      <ol className="flex flex-col gap-1 text-sm">
        {lessons.topics.map((topic, i) => {
          const status = topic.lesson?.status;
          return (
            <li key={topic.topicId}>
              <button
                type="button"
                disabled={!topic.lesson}
                aria-current={topic.lesson?.id === selectedId ? "page" : undefined}
                onClick={() => topic.lesson && onSelect(topic.lesson.id)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                  topic.lesson ? "hover:bg-accent" : "text-muted-foreground cursor-default",
                  topic.lesson?.id === selectedId && "bg-accent font-medium",
                )}
              >
                <span className="mt-0.5 shrink-0" aria-hidden>
                  {status === "finished" ? (
                    <Check className="text-success size-4" />
                  ) : status === "generating" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CircleDashed className="size-4" />
                  )}
                </span>
                <span className="min-w-0">
                  {i + 1}. {topic.title}
                  <span className="sr-only">{status === "finished" ? " (finished)" : status ? " (started)" : " (not started)"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * One lesson as a page: its sections in order, placeholders for those still being written, and the
 * way on once every check is answered.
 */
export type LessonSection = LessonView["sections"][number];

export function LessonPage({
  lessonId,
  nextTopic,
  onFinished,
  onStartNext,
  onExplain,
  onChange,
  onLoaded,
}: {
  lessonId: string;
  /** Ask the tutor about a section; the lesson stays as it is. */
  onExplain?: (section: LessonSection) => void;
  /** Ask the tutor to change a section, which makes a new version. */
  onChange?: (section: LessonSection) => void;
  /** The lesson as last loaded, for the tutor drawer. */
  onLoaded?: (lesson: LessonView) => void;
  /** The topic after this one, if it has no lesson yet. */
  nextTopic: { id: string; title: string } | undefined;
  onFinished: () => void;
  onStartNext: (topicId: string) => Promise<void>;
}) {
  const { lesson, error, apply } = useLesson(lessonId);
  const [updatedViews, setUpdatedViews] = useState<Record<string, ArtifactView>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    if (lesson) loaded.current?.(lesson);
  }, [lesson]);

  if (!lesson) {
    return error ? <p className="text-destructive m-auto p-6">{error}</p> : <p className="text-muted-foreground m-auto p-6">Loading the lesson…</p>;
  }

  const generating = lesson.status === "generating";
  const changeable = lesson.status === "ready";
  const changed = new Set(lesson.changedSectionIds);
  const pending = lesson.outline ? lesson.outline.sections.slice(lesson.sections.length) : [];
  const run = async (action: () => Promise<{ ok: true; value: { lesson: LessonView; revision: string } } | { ok: false; error: string }>) => {
    setBusy(true);
    setActionError(undefined);
    const result = await action();
    setBusy(false);
    if (result.ok) apply(result.value);
    else setActionError(result.error);
    return result.ok;
  };

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 pb-16" aria-busy={generating} aria-labelledby="lesson-title">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">Lesson {lesson.position + 1}</p>
        <h2 id="lesson-title" className="font-heading text-2xl font-semibold">
          {lesson.outline?.title ?? lesson.topicTitle}
        </h2>
        {lesson.status === "finished" && <p className="text-muted-foreground text-sm">Finished. This lesson won't change.</p>}
        {lesson.changeReason && lesson.version && lesson.version > 1 && (
          <p className="text-muted-foreground text-sm" role="status">
            Version {lesson.version}: {lesson.changeReason}
          </p>
        )}
      </header>

      {!lesson.outline && generating && (
        <p className="text-muted-foreground flex items-center gap-2" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Planning the lesson…
        </p>
      )}

      {lesson.sections.map((section) => (
        <section
          key={section.id}
          aria-label={section.title}
          data-changed={changed.has(section.id) || undefined}
          className={cn("group flex min-w-0 flex-col gap-2", changed.has(section.id) && "bg-muted/60 -mx-3 rounded-lg px-3 py-2")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-lg font-medium">{section.title}</h3>
            {changed.has(section.id) && <Badge variant="secondary">Changed in v{lesson.version}</Badge>}
            {(onExplain || (onChange && changeable)) && (
              <div className="ml-auto flex gap-1">
                {onExplain && (
                  <Button variant="ghost" size="xs" onClick={() => onExplain(section)} aria-label={`Explain: ${section.title}`}>
                    <HelpCircle aria-hidden /> Explain
                  </Button>
                )}
                {onChange && changeable && (
                  <Button variant="ghost" size="xs" onClick={() => onChange(section)} aria-label={`Change: ${section.title}`}>
                    <Pencil aria-hidden /> Change
                  </Button>
                )}
              </div>
            )}
          </div>
          {section.kind === "prose" ? (
            <MathText text={section.markdown} />
          ) : (
            <ArtifactPart
              data={(section.artifact as { id?: string })?.id ? (updatedViews[(section.artifact as { id: string }).id] ?? section.artifact) : section.artifact}
              replyInProgress={false}
              onUpdate={(view) => setUpdatedViews((prev) => mergeViews(prev, { [view.id]: view }))}
              onRefresh={async () => {
                const result = await getLesson(lessonId);
                if (result.ok) apply(result.value);
              }}
            />
          )}
        </section>
      ))}

      {generating &&
        pending.map((section, i) => (
          <section key={`pending-${i}`} aria-label={`${section.title} (being written)`} className="flex flex-col gap-2">
            <h3 className="font-heading text-muted-foreground text-lg font-medium">{section.title}</h3>
            {i === 0 ? (
              <>
                <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Writing…
                </p>
                <Skeleton className="h-16 w-full" />
              </>
            ) : (
              <Skeleton className="h-4 w-1/3" />
            )}
          </section>
        ))}

      {lesson.status === "failed" && (
        <Alert variant="destructive">
          <AlertTitle>{lesson.error}</AlertTitle>
          <AlertDescription>
            <p>The sections above are kept. Mivra can carry on from here.</p>
            <Button className="mt-2" size="sm" disabled={busy} onClick={() => void run(() => retryLesson(lessonId))}>
              Continue writing
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {(lesson.status === "ready" || lesson.status === "finished") && (
        <footer className="flex flex-col gap-3 border-t pt-4" aria-live="polite">
          {lesson.status === "ready" ? (
            <>
              <p className="text-muted-foreground text-sm">
                {lesson.checks.answered} of {lesson.checks.total} checks answered.
                {!lesson.canFinish && " Answer every check to finish; your score doesn't matter."}
              </p>
              <Button
                className="self-start"
                disabled={!lesson.canFinish || busy}
                onClick={async () => {
                  if (await run(() => finishLesson(lessonId))) onFinished();
                }}
              >
                Finish lesson
              </Button>
            </>
          ) : !nextTopic ? (
            <p className="font-medium">You've reached the end of the syllabus.</p>
          ) : (
            <Button
              className="self-start"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onStartNext(nextTopic.id);
                setBusy(false);
              }}
            >
              Next lesson: {nextTopic.title}
            </Button>
          )}
          {actionError && <p className="text-destructive text-sm">{actionError}</p>}
        </footer>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </article>
  );
}
