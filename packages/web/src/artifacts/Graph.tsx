import { graphEdgeLookup, type GraphSpec, type GraphTone } from "@mivra/protocol";
import { Check } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { edgeText, LABEL_FONT_PX, layoutGraph } from "./graph-layout.js";
import { ScrollableText, SeenOnly, StepperControls, useStepper } from "./stepper.js";

/** The smallest the graph is drawn, so labels stay at 11px or more. Past this it scrolls in its own box. */
const MIN_SCALE = 11 / LABEL_FONT_PX;
/** How much of a node's box its label leaves free, in px at natural size. A step's thicker border doesn't change it. */
const NODE_LABEL_INSET = { x: 2, y: 4 };
/** Rounding in the browser's measurements isn't a label being cut short. */
const CLIP_TOLERANCE_PX = 0.5;
const em = (px: number) => `${px / LABEL_FONT_PX}em`;

// No amber here: that's for the brand. Each tone also differs by more than colour: active is thick, done has
// a tick on nodes and a medium line on edges, and muted is dashed.
const NODE_TONES: Record<GraphTone, string> = {
  active: "border-foreground border-[3px] bg-muted font-semibold",
  done: "border-success border-2 bg-[color-mix(in_oklab,var(--success)_15%,var(--card))]",
  muted: "border-muted-foreground/50 bg-muted text-muted-foreground border-dashed",
};
const EDGE_TONES: Record<GraphTone, { stroke: string; fill: string; width: number; dash?: string }> = {
  active: { stroke: "stroke-foreground", fill: "fill-foreground", width: 3.5 },
  done: { stroke: "stroke-success", fill: "fill-success", width: 2.5 },
  muted: { stroke: "stroke-muted-foreground/50", fill: "fill-muted-foreground/50", width: 1.25, dash: "4 4" },
};
const EDGE_LABEL_TONES: Record<GraphTone, string> = {
  active: "font-semibold",
  done: "text-success",
  muted: "text-muted-foreground",
};
const TONE_WORDS: Record<GraphTone, string> = { active: "active", done: "done", muted: "ruled out" };

/** What to draw at a step, following the spec's state rules: node and edge states belong to that step only. */
export function graphStateAt(spec: GraphSpec, index: number) {
  const step = spec.steps?.[index];
  const lookup = graphEdgeLookup(spec);
  const nodes = new Map<string, GraphTone>();
  for (const state of step?.nodeStates ?? []) nodes.set(state.id, state.tone ?? "active");
  const edges = new Map<number, GraphTone>();
  for (const state of step?.edgeStates ?? []) {
    const found = lookup(state);
    if ("index" in found) edges.set(found.index, state.tone ?? "active");
  }
  return { explanation: step?.explanation ?? "", nodes, edges, variables: step?.variables ?? [] };
}

/**
 * Holds a label to the room the layout gave it, so that however wide it renders it can't reach its neighbours.
 * Whether it was cut short only decides how it's shown, and never moves anything.
 */
function ClippedLabel({ labelKey, width, height, truncated, children }: { labelKey: string; width: number; height: number; truncated: boolean; children: ReactNode }) {
  return (
    <span
      className="relative block overflow-hidden"
      style={{ width: em(width), height: em(height) }}
      data-label-clip={labelKey}
      data-truncated={truncated ? "true" : undefined}
    >
      {/* Fades rather than covers the end, as what's behind depends on the step and the node's border is close by. */}
      <span className={cn("grid size-full items-center", truncated ? "justify-items-start mask-r-from-[calc(100%-1.4em)] mask-r-to-[calc(100%-0.8em)]" : "justify-items-center")}>
        <span className="w-max whitespace-nowrap" data-label-content>
          {children}
        </span>
      </span>
      {truncated && (
        <span className="absolute inset-y-0 right-0 grid place-items-center" data-testid="graph-label-cut">
          …
        </span>
      )}
    </span>
  );
}

export function Graph({ view }: ArtifactProps<"graph">) {
  const { spec } = view;
  const steps = spec.steps ?? [];
  const stepper = useStepper(steps.length);

  // The view is parsed afresh on every parent render, so the key is what the layout reads, not the object.
  const shape = JSON.stringify([spec.directed, spec.kind, spec.nodes, spec.edges]);
  const layout = useMemo(() => layoutGraph(spec), [shape]);

  // A graph bigger than its box has little in the corners, so it opens on the middle. A tree opens on its root.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const root = layout.mode === "tree" ? layout.nodes.reduce((top, node) => (node.y < top.y ? node : top)) : undefined;
    box.scrollLeft = root ? (root.x * box.scrollWidth) / layout.width - box.clientWidth / 2 : (box.scrollWidth - box.clientWidth) / 2;
    box.scrollTop = root ? 0 : (box.scrollHeight - box.clientHeight) / 2;
  }, [layout]);

  // Only a box that overflows has anything to do with the keyboard, so only then is it a tab stop.
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const measure = () => setOverflows(box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [layout]);

  // Everything scales together, so a label's fit only changes with the fonts; the rest is for rounding at a new size.
  const canvas = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const measure = () => {
      const cut = [...(canvas.current?.querySelectorAll<HTMLElement>("[data-label-clip]") ?? [])].filter((clip) => {
        const room = clip.getBoundingClientRect();
        const content = clip.querySelector("[data-label-content]")!;
        // KaTeX's line box is taller than what it draws, which each strut is the height of.
        const drawn = [...content.querySelectorAll(".katex-html .strut")].map((strut) => strut.getBoundingClientRect().height);
        const height = drawn.length > 0 ? Math.max(...drawn) : content.getBoundingClientRect().height;
        return content.getBoundingClientRect().width > room.width + CLIP_TOLERANCE_PX || height > room.height + CLIP_TOLERANCE_PX;
      });
      const keys = cut.map((clip) => clip.dataset.labelClip!);
      setTruncated((before) => (before.size === keys.length && keys.every((key) => before.has(key)) ? before : new Set(keys)));
    };
    measure();
    let current = true;
    void document.fonts.ready.then(() => {
      if (current) measure();
    });
    document.fonts.addEventListener?.("loadingdone", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (canvas.current) observer?.observe(canvas.current);
    return () => {
      current = false;
      document.fonts.removeEventListener?.("loadingdone", measure);
      observer?.disconnect();
    };
  }, [shape]);

  // Spec ordinals keep keys stable across steps and font measurements without affecting layout.
  const nodeKeys = new Map(spec.nodes.flatMap((node, i) => truncated.has(`n-${node.id}`) ? [[node.id, `[${i + 1}]`] as const] : []));

  const onKeyDown = (e: KeyboardEvent) => {
    // In the drawing's scrolling box the arrow keys scroll it.
    if (!scroller.current?.contains(e.target as Node)) stepper.onKeyDown(e);
  };

  const state = graphStateAt(spec, stepper.index);
  const hasSteps = steps.length > 0;
  const percent = (value: number, of: number) => `${(value / of) * 100}%`;
  const titleId = useId();
  const kindId = useId();

  return (
    <Card
      role="region"
      aria-labelledby={`${titleId} ${kindId}`}
      tabIndex={hasSteps ? 0 : undefined}
      onKeyDown={hasSteps ? onKeyDown : undefined}
      className="whitespace-normal"
    >
      <CardHeader>
        <CardTitle className="min-w-0 font-heading text-base">
          <h3>
            <ScrollableText>
              {/* The name comes from inside the box, which is itself named "Formula" when it scrolls. */}
              <span id={titleId}>
                <MathText text={spec.title} mode="math" />
              </span>
            </ScrollableText>
          </h3>
        </CardTitle>
        <CardDescription id={kindId}>{spec.directed ? "Directed graph" : "Graph"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <GraphDescription spec={spec} />
        <div
          ref={scroller}
          className="focus-visible:ring-ring/50 max-h-[36rem] overflow-auto rounded-sm outline-none focus-visible:ring-[3px]"
          data-testid="graph-scroll"
          {...(overflows ? { tabIndex: 0, role: "group", "aria-label": "Scrollable graph drawing" } : {})}
        >
          {/* Everything scales with this box: the SVG by its viewBox, the labels by container units. */}
          <div
            ref={canvas}
            className="@container relative mx-auto w-full"
            style={{ maxWidth: layout.width, minWidth: layout.width * MIN_SCALE, aspectRatio: `${layout.width} / ${layout.height}` }}
            aria-hidden="true"
            data-testid="graph-canvas"
            data-layout={layout.mode}
          >
            <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="absolute inset-0 size-full" fill="none">
              {layout.edges.map((edge, i) => {
                const tone = state.edges.get(i);
                const look = tone ? EDGE_TONES[tone] : { stroke: "stroke-muted-foreground", fill: "fill-muted-foreground", width: 1.5, dash: undefined };
                return (
                  <g key={i} data-testid="graph-edge" data-tone={tone}>
                    <path d={edge.path} className={look.stroke} strokeWidth={look.width} strokeDasharray={look.dash} strokeLinecap="round" />
                    {edge.arrow && <polygon points={edge.arrow} className={look.fill} data-testid="graph-arrow" />}
                  </g>
                );
              })}
            </svg>
            {/* Labels are HTML over the SVG, not foreignObject: WebKit misplaces the positioned parts of KaTeX's HTML there. */}
            <div className="absolute inset-0 font-mono leading-none" style={{ fontSize: `calc(${LABEL_FONT_PX} * 100cqw / ${layout.width})` }}>
              {spec.edges.map((edge, i) => {
                const text = edgeText(edge);
                const at = layout.edges[i]!.label;
                const tone = state.edges.get(i);
                return text === undefined ? null : (
                  <span
                    key={i}
                    className={cn("bg-card absolute -translate-x-1/2 -translate-y-1/2 rounded-sm [&_.katex]:text-[1.1em]!", tone && EDGE_LABEL_TONES[tone])}
                    style={{ left: percent(at.x, layout.width), top: percent(at.y, layout.height) }}
                    data-testid="graph-edge-label"
                  >
                    <ClippedLabel labelKey={`e-${i}`} width={at.width} height={at.height} truncated={truncated.has(`e-${i}`)}>
                      {edge.weight !== undefined ? text : <MathText text={text} mode="math" />}
                    </ClippedLabel>
                  </span>
                );
              })}
              {layout.nodes.map((node, i) => {
                const tone = state.nodes.get(node.id);
                return (
                  <div
                    key={node.id}
                    className={cn(
                      "absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border",
                      tone ? NODE_TONES[tone] : "border-muted-foreground bg-card",
                    )}
                    style={{
                      left: percent(node.x, layout.width),
                      top: percent(node.y, layout.height),
                      width: percent(node.width, layout.width),
                      height: percent(node.height, layout.height),
                    }}
                    data-testid="graph-node"
                    data-node={node.id}
                    data-tone={tone}
                  >
                    <ClippedLabel labelKey={`n-${node.id}`} width={node.width - NODE_LABEL_INSET.x} height={node.height - NODE_LABEL_INSET.y} truncated={truncated.has(`n-${node.id}`)}>
                      <span className={nodeKeys.has(node.id) ? "invisible" : undefined}><MathText text={spec.nodes[i]!.label ?? node.id} mode="math" /></span>
                    </ClippedLabel>
                    {nodeKeys.has(node.id) && <span className="bg-card absolute rounded-sm px-1" data-node-key={nodeKeys.get(node.id)}>{nodeKeys.get(node.id)}</span>}
                    {tone === "done" && (
                      <span className="bg-success text-card absolute -top-[0.35em] -right-[0.35em] grid size-[1.05em] place-items-center rounded-full">
                        <Check className="size-[0.8em]" strokeWidth={3.5} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <CutShortLabels spec={spec} truncated={truncated} nodeKeys={nodeKeys} />
        {state.variables.length > 0 && (
          <dl className="flex flex-wrap gap-2" aria-hidden={hasSteps ? true : undefined}>
            {state.variables.map((v, i) => (
              <div key={i} className="bg-muted flex max-w-full min-w-0 gap-1 rounded-sm px-2 py-0.5 font-mono text-xs wrap-anywhere">
                <dt className="min-w-0">{v.name}</dt>
                <dd className="min-w-0">= {String(v.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {hasSteps && (
          <>
            <GraphStatus spec={spec} state={state} step={stepper.index + 1} of={steps.length} />
            <StepperControls stepper={stepper} play />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The whole of each label the drawing cut short. Screen readers already have them in the graph's description. */
function CutShortLabels({ spec, truncated, nodeKeys }: { spec: GraphSpec; truncated: ReadonlySet<string>; nodeKeys: ReadonlyMap<string, string> }) {
  if (truncated.size === 0) return null;
  const arrow = spec.directed ? "→" : "–";
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="graph-overflow">
      <p aria-hidden="true" className="text-muted-foreground">
        … Cut short in the drawing:
      </p>
      {spec.nodes.map((node) =>
        truncated.has(`n-${node.id}`) ? (
          <SeenOnly key={node.id}>
            <span className="font-medium">Node {nodeKeys.get(node.id)}:</span> <NodeName spec={spec} id={node.id} />
          </SeenOnly>
        ) : null,
      )}
      {spec.edges.map((edge, i) =>
        truncated.has(`e-${i}`) ? (
          <SeenOnly key={i}>
            <span className="font-medium">
              Edge {nodeKeys.get(edge.from) ?? <NodeName spec={spec} id={edge.from} />} {arrow} {nodeKeys.get(edge.to) ?? <NodeName spec={spec} id={edge.to} />}:
            </span>{" "}
            {edge.weight !== undefined ? edge.weight : <MathText text={edge.label!} mode="math" />}
          </SeenOnly>
        ) : null,
      )}
    </div>
  );
}

function NodeName({ spec, id }: { spec: GraphSpec; id: string }) {
  return <MathText text={spec.nodes.find((node) => node.id === id)?.label ?? id} mode="math" />;
}

function EdgeWords({ spec, index }: { spec: GraphSpec; index: number }) {
  const edge = spec.edges[index]!;
  return (
    <>
      {edge.from === edge.to ? (
        <>
          <NodeName spec={spec} id={edge.from} /> to itself
        </>
      ) : (
        <>
          <NodeName spec={spec} id={edge.from} /> {spec.directed ? "to" : "and"} <NodeName spec={spec} id={edge.to} />
        </>
      )}
      {edge.side && `, ${edge.side} child`}
      {edge.weight !== undefined && `, weight ${edge.weight}`}
      {edge.label !== undefined && (
        <>
          , labelled <MathText text={edge.label} mode="math" />
        </>
      )}
    </>
  );
}

/**
 * Stays mounted and is read whole on every change. The step number changes every time, so two steps with the
 * same explanation are still announced, along with what's highlighted, which is otherwise only visible.
 */
function GraphStatus({ spec, state, step, of }: { spec: GraphSpec; state: ReturnType<typeof graphStateAt>; step: number; of: number }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="graph-status">
      <p className="sr-only">
        Step {step} of {of}.
      </p>
      <div data-testid="graph-explanation">
        <ScrollableText>
          <MathText text={state.explanation} mode="math" />
        </ScrollableText>
      </div>
      <ul className="sr-only">
        {[...state.nodes].map(([id, tone]) => (
          <li key={`n-${id}`}>
            Node <NodeName spec={spec} id={id} /> is {TONE_WORDS[tone]}.
          </li>
        ))}
        {[...state.edges].map(([i, tone]) => (
          <li key={`e-${i}`}>
            Edge <EdgeWords spec={spec} index={i} /> is {TONE_WORDS[tone]}.
          </li>
        ))}
        {state.variables.map((v, i) => (
          <li key={`v-${i}`}>
            {v.name} = {String(v.value)}.
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The drawing relates things only by position, so screen readers get this instead. */
function GraphDescription({ spec }: { spec: GraphSpec }) {
  const nodeCount = spec.nodes.length;
  const edgeCount = spec.edges.length;
  return (
    <ul className="sr-only" data-testid="graph-description">
      <li>
        {spec.directed ? "Directed" : "Undirected"} graph with {nodeCount} {nodeCount === 1 ? "node" : "nodes"} and {edgeCount} {edgeCount === 1 ? "edge" : "edges"}.
      </li>
      <li>
        Nodes:{" "}
        {spec.nodes.map((node, i) => (
          <span key={node.id}>
            {i > 0 && ", "}
            <NodeName spec={spec} id={node.id} />
          </span>
        ))}
      </li>
      {spec.edges.map((_, i) => (
        <li key={`e-${i}`}>
          Edge: <EdgeWords spec={spec} index={i} />
        </li>
      ))}
    </ul>
  );
}
