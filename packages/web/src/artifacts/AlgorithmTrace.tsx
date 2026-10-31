import type { AlgorithmTraceSpec, TraceStep } from "@mivra/protocol";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";

const PLAY_INTERVAL_MS = 1500;

type Range = NonNullable<TraceStep["ranges"]>[number];
type Tone = NonNullable<Range["tone"]>;

const RANGE_TONES: Record<Tone, string> = {
  active: "bg-accent text-accent-foreground",
  done: "bg-success/15 text-success",
  muted: "bg-muted text-muted-foreground",
};
const CELL_TONES: Record<Tone, string> = {
  active: "border-primary bg-accent",
  done: "border-success bg-success/15",
  muted: "bg-muted text-muted-foreground",
};

/**
 * What to draw at a step, following the spec's state rules: `values` persists from the latest step
 * that set it; pointers, ranges and variables belong to that step only.
 */
export function traceStateAt(spec: AlgorithmTraceSpec, index: number) {
  let values = spec.values;
  for (const step of spec.steps.slice(0, index + 1)) {
    if (step.values) values = step.values;
  }
  const step = spec.steps[index];
  return {
    values,
    explanation: step?.explanation ?? "",
    pointers: step?.pointers ?? [],
    ranges: step?.ranges ?? [],
    variables: step?.variables ?? [],
  };
}

export function AlgorithmTrace({ view }: ArtifactProps<"algorithm_trace">) {
  const { spec } = view;
  const last = spec.steps.length - 1;
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

  const state = traceStateAt(spec, index);
  const n = state.values.length;
  // Bounds are checked server-side; still skip anything outside the sequence rather than misdraw it.
  const ranges = state.ranges.filter((r) => r.start <= r.end && r.end < n);
  const pointers = state.pointers.filter((p) => p.index < n);
  const toneAt = (i: number): Tone | undefined => {
    const range = ranges.find((r) => r.start <= i && i <= r.end);
    return range ? (range.tone ?? "active") : undefined;
  };

  return (
    <Card role="region" aria-label={`Algorithm trace: ${spec.title}`} tabIndex={0} onKeyDown={onKeyDown} className="whitespace-normal">
      <CardHeader>
        <CardTitle className="font-heading text-base">
          <h3>
            <MathText text={spec.title} mode="math" />
          </h3>
        </CardTitle>
        <CardDescription>Algorithm trace</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* The grid relates pointers and ranges to cells only by position, so screen readers get this instead. */}
        <ul className="sr-only" data-testid="trace-description">
          <li>Values: {state.values.map((v, i) => `index ${i}: ${String(v)}`).join(", ")}</li>
          {pointers.map((p, i) => (
            <li key={`p-${i}`}>
              {p.name} points to index {p.index}, value {String(state.values[p.index])}
            </li>
          ))}
          {ranges.map((r, i) => (
            <li key={`r-${i}`}>
              {r.label ? `${r.label} covers` : "Highlighted:"} indices {r.start} through {r.end}
            </li>
          ))}
        </ul>
        <div className="overflow-x-auto pb-1" aria-hidden="true">
          <div className="inline-grid w-max gap-1 wrap-normal" style={{ gridTemplateColumns: `repeat(${n}, minmax(2.5rem, max-content))` }}>
            {ranges.map((r, i) => (
              <div
                key={`range-${i}`}
                className={cn("min-h-5 rounded-sm px-1 text-center text-xs font-medium", RANGE_TONES[r.tone ?? "active"])}
                style={{ gridColumn: `${r.start + 1} / ${r.end + 2}`, gridRow: i + 1 }}
                data-testid="trace-range"
              >
                {r.label ?? " "}
              </div>
            ))}
            {state.values.map((value, i) => {
              const tone = toneAt(i);
              return (
                <div
                  key={`cell-${i}`}
                  className={cn(
                    "bg-background relative grid h-10 place-items-center rounded-sm border px-2 font-mono text-sm",
                    tone && CELL_TONES[tone],
                  )}
                  style={{ gridColumn: i + 1, gridRow: ranges.length + 1 }}
                  data-testid="trace-cell"
                >
                  {String(value)}
                  <span className="text-muted-foreground absolute right-1 bottom-0 text-[0.6rem]">{i}</span>
                </div>
              );
            })}
            {Array.from({ length: n }, (_, i) => {
              const names = pointers.filter((p) => p.index === i).map((p) => p.name);
              return names.length ? (
                <div
                  key={`pointers-${i}`}
                  className="text-accent-foreground text-center font-mono text-xs font-medium"
                  style={{ gridColumn: i + 1, gridRow: ranges.length + 2 }}
                  data-testid="trace-pointer"
                >
                  ↑ {names.join(", ")}
                </div>
              ) : null;
            })}
          </div>
        </div>
        {state.variables.length > 0 && (
          <dl className="flex flex-wrap gap-2">
            {state.variables.map((v, i) => (
              <div key={i} className="bg-muted flex gap-1 rounded-sm px-2 py-0.5 font-mono text-xs">
                <dt>{v.name}</dt>
                <dd>= {String(v.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div aria-live="polite">
          <MathText text={state.explanation} mode="math" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => go(index - 1)} disabled={index === 0}>
            <ChevronLeft />
            Prev
          </Button>
          <Button type="button" size="sm" onClick={togglePlay} aria-pressed={playing}>
            {playing ? <Pause /> : <Play />}
            {playing ? "Pause" : "Play"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => go(index + 1)} disabled={index === last}>
            Next
            <ChevronRight />
          </Button>
          <Badge variant="outline" className="ml-auto">
            Step {index + 1} of {spec.steps.length}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
