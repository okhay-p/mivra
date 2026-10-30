import type { AlgorithmTraceSpec, TraceStep } from "@mivra/protocol";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { ArtifactProps } from "./ArtifactPart.js";

const PLAY_INTERVAL_MS = 1500;

type Range = NonNullable<TraceStep["ranges"]>[number];

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
  const toneAt = (i: number): Range["tone"] | undefined => {
    const range = ranges.find((r) => r.start <= i && i <= r.end);
    return range ? (range.tone ?? "active") : undefined;
  };

  return (
    <section
      className="artifact trace"
      aria-label={`Algorithm trace: ${spec.title}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <h3>{spec.title}</h3>
      <div className="trace-scroll">
        <div className="trace-grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(2.5rem, max-content))` }}>
          {ranges.map((r, i) => (
            <div
              key={`range-${i}`}
              className={`trace-range tone-${r.tone ?? "active"}`}
              style={{ gridColumn: `${r.start + 1} / ${r.end + 2}`, gridRow: i + 1 }}
              data-testid="trace-range"
            >
              {r.label ?? " "}
            </div>
          ))}
          {state.values.map((value, i) => {
            const tone = toneAt(i);
            return (
              <div
                key={`cell-${i}`}
                className={`trace-cell${tone ? ` tone-${tone}` : ""}`}
                style={{ gridColumn: i + 1, gridRow: ranges.length + 1 }}
                data-testid="trace-cell"
              >
                {String(value)}
                <span className="trace-index">{i}</span>
              </div>
            );
          })}
          {Array.from({ length: n }, (_, i) => {
            const names = pointers.filter((p) => p.index === i).map((p) => p.name);
            return names.length ? (
              <div
                key={`pointers-${i}`}
                className="trace-pointers"
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
        <dl className="trace-variables">
          {state.variables.map((v, i) => (
            <div key={i}>
              <dt>{v.name}</dt>
              <dd>{String(v.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="trace-explanation" aria-live="polite">
        {state.explanation}
      </p>
      <div className="trace-controls">
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0}>
          ← Prev
        </button>
        <button type="button" onClick={togglePlay} aria-pressed={playing}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => go(index + 1)} disabled={index === last}>
          Next →
        </button>
        <span className="trace-counter">
          Step {index + 1} of {spec.steps.length}
        </span>
      </div>
    </section>
  );
}
