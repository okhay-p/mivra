import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const PLAY_INTERVAL_MS = 1500;

export type StepTone = "active" | "done" | "muted";

/**
 * How a stepped artifact marks what it's showing. Amber is for the brand, so the current thing is neutral, and
 * its heavy foreground outline sets it apart from `muted`, which shares its background, without relying on hue.
 */
export const STEP_TONES: Record<StepTone, string> = {
  active: "bg-secondary ring-2 ring-inset ring-foreground",
  done: "bg-success/15 ring-1 ring-inset ring-success",
  muted: "bg-muted text-muted-foreground",
};
/** The rule beside a step in a list: thicker and darker for the current one, with the text staying in line. */
export const STEP_RULES = { current: "border-l-4 border-foreground pl-2.5", other: "border-l-2 border-border pl-3" };

/** Where a stepped artifact is: prev/next within bounds, play/pause, and the arrow keys for its container. */
export function useStepper(count: number) {
  const last = count - 1;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex((i) => Math.min(i + 1, last)), PLAY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, index, last]);

  const go = (next: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(next, last)));
  };
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (index >= last) setIndex(0); // Replay from the start.
    setPlaying(true);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "ArrowRight") go(index + 1);
    else return;
    e.preventDefault();
  };
  return { index, last, playing, go, togglePlay, onKeyDown };
}

/**
 * Text in a stepped artifact whose formula may be too wide for the card. The whole text scrolls as one box, and
 * only when it has to is that box a tab stop, whose arrow keys scroll rather than step. A box that stops
 * overflowing while focused stays focusable, out of the tab order, until focus leaves, so the keyboard keeps its place.
 */
export function ScrollableText({ children }: { children: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [focused, setFocused] = useState(false);
  const measure = () => {
    if (box.current) setOverflows(box.current.scrollWidth > box.current.clientWidth);
  };
  // Every render, as the text may be new; the size and the maths font can also change without one.
  useLayoutEffect(measure);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(box.current!);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, []);
  return (
    <span
      ref={box}
      className="step-scroll block min-w-0 overflow-x-auto overflow-y-hidden"
      data-testid="step-scroll"
      {...(overflows ? { role: "group", "aria-label": "Formula, scrolls sideways" } : {})}
      tabIndex={overflows ? 0 : focused ? -1 : undefined}
      onFocus={() => setFocused(true)}
      // Leaving the window blurs the box but keeps it the active element, for when the window comes back.
      onBlur={(e) => setFocused(document.activeElement === e.currentTarget)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
      }}
    >
      {children}
    </span>
  );
}

/**
 * Prev, next and a step counter, or nothing for a single step or none. At either end a button is `aria-disabled`, not
 * `disabled`, because a disabled button drops the keyboard focus of someone who has just stepped to the end.
 * An artifact that announces the step number in its own live region passes `announce={false}`, which also hides
 * this copy from screen readers, so it's said once. There's no `aria-pressed` on Play: its label already changes.
 */
export function StepperControls({
  stepper,
  play = false,
  announce = true,
  children,
}: {
  stepper: ReturnType<typeof useStepper>;
  play?: boolean;
  announce?: boolean;
  children?: ReactNode;
}) {
  const { index, last, playing, go, togglePlay } = stepper;
  if (last <= 0) return null;
  const inactive = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" className={inactive} onClick={() => go(index - 1)} aria-disabled={index === 0}>
        <ChevronLeft />
        Prev
      </Button>
      {play && (
        <Button type="button" size="sm" onClick={togglePlay}>
          {playing ? <Pause /> : <Play />}
          {playing ? "Pause" : "Play"}
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" className={inactive} onClick={() => go(index + 1)} aria-disabled={index === last}>
        Next
        <ChevronRight />
      </Button>
      {children}
      <Badge variant="outline" className="ml-auto" role={announce ? "status" : undefined} aria-hidden={announce ? undefined : true} data-testid="step-counter">
        Step {index + 1} of {last + 1}
      </Badge>
    </div>
  );
}
