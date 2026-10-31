import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const PLAY_INTERVAL_MS = 1500;

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
 * Prev, next and a step counter, or nothing for a single step. At either end a button is `aria-disabled`, not
 * `disabled`, because a disabled button drops the keyboard focus of someone who has just stepped to the end.
 */
export function StepperControls({ stepper, play = false, children }: { stepper: ReturnType<typeof useStepper>; play?: boolean; children?: ReactNode }) {
  const { index, last, playing, go, togglePlay } = stepper;
  if (last === 0) return null;
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
      <Badge variant="outline" className="ml-auto" role="status">
        Step {index + 1} of {last + 1}
      </Badge>
    </div>
  );
}
