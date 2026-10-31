import type { SetDiagramHighlight, SetDiagramSpec } from "@mivra/protocol";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { Fragment, useEffect, useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { FRAME_INSET, ROW_HEIGHT, VENN_LAYOUTS, regionMasks, regionPath, slotCapacity, type VennLayout } from "./set-diagram-geometry.js";

const PLAY_INTERVAL_MS = 1500;

type Tone = NonNullable<SetDiagramHighlight["tone"]>;
type Region = SetDiagramSpec["regions"][number];

/** Each tone differs by its pattern, outline and the words in the key, not just by colour. Amber is the brand's, so none use it. */
const TONES: Record<Tone, { word: string; tint: string; pattern: string; line: string; outline: string }> = {
  active: { word: "Focus", tint: "fill-foreground/15", pattern: "hatch", line: "stroke-foreground", outline: "" },
  done: { word: "Done", tint: "fill-success/20", pattern: "dots", line: "stroke-success", outline: "" },
  muted: { word: "Ruled out", tint: "fill-muted-foreground/15", pattern: "", line: "stroke-muted-foreground", outline: "5 4" },
};

/** The region an `in` list names, as a mask over `spec.sets`. Every id is checked by the schema. */
export function regionMask(spec: SetDiagramSpec, ids: readonly string[]): number {
  return spec.sets.reduce((mask, set, i) => (ids.includes(set.id) ? mask | (1 << i) : mask), 0);
}

/** What to draw at a step. Highlights and variables belong to that step only, so nothing is carried forward. */
export function setDiagramStateAt(spec: SetDiagramSpec, index: number) {
  const step = spec.steps?.[index];
  const tones = new Map<number, Tone>();
  for (const highlight of step?.highlights ?? []) tones.set(regionMask(spec, highlight.in), highlight.tone ?? "active");
  return { explanation: step?.explanation ?? "", tones, variables: step?.variables ?? [] };
}

/** The regions a diagram can have, in reading order: most sets first, then outside, which only exists with a universe. */
function drawnMasks(spec: SetDiagramSpec): number[] {
  return regionMasks(spec.sets.length)
    .filter((mask) => mask !== 0 || spec.universe !== undefined)
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
}

const elementText = (element: Region["elements"][number]) => String(element);

function Inline({ text }: { text: string }) {
  return <MathText text={text} mode="math" />;
}

function Elements({ elements }: { elements: Region["elements"] }) {
  return elements.map((element, i) => (
    <Fragment key={i}>
      {i > 0 && ", "}
      <Inline text={elementText(element)} />
    </Fragment>
  ));
}

function listOf(items: ReactNode[], word: "and" | "or") {
  return items.map((item, i) => (
    <Fragment key={i}>
      {i > 0 && (i === items.length - 1 ? ` ${word} ` : ", ")}
      {item}
    </Fragment>
  ));
}

/** A region in words, such as "in A and B, not C". Labels are maths-aware, so a screen reader gets KaTeX's MathML. */
function RegionName({ spec, mask }: { spec: SetDiagramSpec; mask: number }) {
  const label = (set: SetDiagramSpec["sets"][number]) => <Inline key={set.id} text={set.label} />;
  const inside = spec.sets.filter((_, i) => mask & (1 << i)).map(label);
  const outside = spec.sets.filter((_, i) => !(mask & (1 << i))).map(label);
  if (inside.length === 0) return <>outside {listOf(outside, "and")}</>;
  return (
    <>
      in {listOf(inside, "and")}
      {outside.length > 0 && <>, not {listOf(outside, "or")}</>}
    </>
  );
}

/** What's shown in a region's slot, or that it's too much to fit, in which case the list below the diagram has it. */
export function regionContents(region: Region | undefined, capacity: number) {
  if (!region) return { kind: "none" as const };
  const total = region.count ?? region.elements.length;
  if (total === 0) return { kind: "empty" as const };
  const suffix = region.count !== undefined && region.elements.length > 0 && region.count !== region.elements.length ? ` (${region.count})` : "";
  const length = region.elements.map(elementText).join(", ").length + suffix.length;
  if (region.elements.length === 0) return { kind: "count" as const, total };
  return length <= capacity ? { kind: "elements" as const, elements: region.elements, suffix } : { kind: "overflow" as const, total };
}

/** A set's label goes in a corner next to its circle. */
function labelPosition(index: number, count: number): CSSProperties {
  if (index === 0) return { left: "2%", top: "1.5%", width: "45%" };
  if (index === 1) return { right: "2%", top: "1.5%", width: "45%", textAlign: "right" };
  return { left: "2%", bottom: "1.5%", width: count === 3 ? "30%" : "45%" };
}

function RegionShape({ d, mask, tone, ids }: { d: string; mask: number; tone: Tone | undefined; ids: { hatch: string; dots: string; clip: string } }) {
  const style = tone && TONES[tone];
  const clip = `${ids.clip}-${mask}`;
  return (
    <g data-testid="set-region" data-mask={mask} data-tone={tone ?? "none"}>
      <path d={d} fillRule="evenodd" className={style ? style.tint : "fill-transparent"} data-testid="set-region-shape" />
      {style && (
        <>
          {style.pattern && <path d={d} fillRule="evenodd" fill={`url(#${style.pattern === "hatch" ? ids.hatch : ids.dots})`} />}
          {/* The outline is drawn double-width and clipped, so it only falls inside this region. */}
          <clipPath id={clip}>
            <path d={d} clipRule="evenodd" />
          </clipPath>
          <path d={d} clipPath={`url(#${clip})`} fill="none" strokeWidth={6} strokeDasharray={style.outline || undefined} className={style.line} />
        </>
      )}
    </g>
  );
}

function Diagram({ spec, layout, tones }: { spec: SetDiagramSpec; layout: VennLayout; tones: Map<number, Tone> }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = { hatch: `${id}-hatch`, dots: `${id}-dots`, clip: `${id}-clip` };
  const { width, height, radius, circles, slots } = layout;
  const masks = drawnMasks(spec);
  const regions = new Map(spec.regions.map((r) => [regionMask(spec, r.in), r]));
  const percent = (value: number, of: number) => `${(value / of) * 100}%`;

  return (
    <div className="relative mx-auto w-full max-w-md" style={{ aspectRatio: `${width} / ${height}` }} aria-hidden="true" data-testid="set-diagram">
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 size-full">
        <defs>
          <pattern id={ids.hatch} patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="10" strokeWidth="2" className="stroke-foreground/45" />
          </pattern>
          <pattern id={ids.dots} patternUnits="userSpaceOnUse" width="10" height="10">
            <circle cx="5" cy="5" r="1.6" className="fill-success/70" />
          </pattern>
        </defs>
        {masks.map((mask) => (
          <RegionShape key={mask} d={regionPath(layout, mask)} mask={mask} tone={tones.get(mask)} ids={ids} />
        ))}
        {spec.universe !== undefined && (
          <rect
            x={FRAME_INSET}
            y={FRAME_INSET}
            width={width - 2 * FRAME_INSET}
            height={height - 2 * FRAME_INSET}
            strokeWidth="1.5"
            className="stroke-muted-foreground fill-none"
            data-testid="set-universe"
          />
        )}
        {circles.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={radius} strokeWidth="1.5" className="stroke-foreground/70 fill-none" data-testid="set-circle" />
        ))}
      </svg>
      {spec.sets.map((set, i) => (
        <div key={set.id} className="absolute text-xs leading-4 font-medium" style={labelPosition(i, spec.sets.length)} data-testid="set-label">
          <span className="bg-card/85 rounded-sm px-0.5">
            <Inline text={set.label} />
          </span>
        </div>
      ))}
      {spec.universe !== undefined && (
        <div className="text-muted-foreground absolute bottom-[1.5%] left-1/2 w-[36%] -translate-x-1/2 text-center text-xs leading-4" data-testid="set-universe-label">
          <span className="bg-card/85 rounded-sm px-0.5">
            <Inline text={spec.universe} />
          </span>
        </div>
      )}
      {masks.map((mask) => {
        const slot = slots[mask]!;
        const contents = regionContents(regions.get(mask), slotCapacity(slot));
        if (contents.kind === "none") return null;
        return (
          <div
            key={mask}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center text-center font-mono text-xs leading-4"
            style={{ left: percent(slot.x, width), top: percent(slot.y, height), width: percent(slot.width, width), height: percent(slot.rows * ROW_HEIGHT, height) }}
            data-testid="set-elements"
            data-mask={mask}
          >
            <span className="bg-card/85 rounded-sm px-0.5">
              {contents.kind === "elements" && (
                <>
                  <Elements elements={contents.elements} />
                  {contents.suffix}
                </>
              )}
              {contents.kind === "count" && contents.total}
              {contents.kind === "empty" && "∅"}
              {contents.kind === "overflow" && `${contents.total} ↓`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function SetDiagram({ view }: ArtifactProps<"set_diagram">) {
  const { spec } = view;
  const stepCount = spec.steps?.length ?? 0;
  const last = stepCount - 1;
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

  const layout = VENN_LAYOUTS[spec.sets.length]!;
  const state = setDiagramStateAt(spec, index);
  const masks = drawnMasks(spec);
  const regions = new Map(spec.regions.map((r) => [regionMask(spec, r.in), r]));
  const highlighted = masks.filter((mask) => state.tones.has(mask));
  const overflowing = masks.filter((mask) => regionContents(regions.get(mask), slotCapacity(layout.slots[mask]!)).kind === "overflow");

  return (
    <Card role="region" aria-label={`Set diagram: ${spec.title}`} {...(stepCount > 0 ? { tabIndex: 0, onKeyDown } : {})} className="whitespace-normal">
      <CardHeader>
        <CardTitle className="font-heading text-base">
          <h3>
            <MathText text={spec.title} mode="math" />
          </h3>
        </CardTitle>
        <CardDescription>Set diagram</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* The drawing relates elements to sets only by position, so screen readers get this instead. */}
        <ul className="sr-only" data-testid="set-description">
          {spec.sets.map((set) => (
            <li key={set.id}>
              Set: <Inline text={set.label} />
            </li>
          ))}
          {spec.universe !== undefined && (
            <li>
              Universe: <Inline text={spec.universe} />
            </li>
          )}
          {masks.map((mask) => {
            const region = regions.get(mask);
            if (!region) return null;
            const empty = region.elements.length === 0 && !region.count;
            return (
              <li key={mask}>
                <RegionName spec={spec} mask={mask} />: {empty && "empty"}
                <Elements elements={region.elements} />
                {region.count !== undefined && region.count !== region.elements.length && !empty && `${region.elements.length > 0 ? ", " : ""}${region.count} in total`}
              </li>
            );
          })}
          {highlighted.map((mask) => (
            <li key={`highlight-${mask}`}>
              {TONES[state.tones.get(mask)!].word}: <RegionName spec={spec} mask={mask} />
            </li>
          ))}
        </ul>
        <Diagram spec={spec} layout={layout} tones={state.tones} />
        {overflowing.length > 0 && (
          <div aria-hidden="true" className="flex flex-col gap-1 text-xs" data-testid="set-overflow">
            <p className="text-muted-foreground">↓ Too many to fit in the diagram:</p>
            <ul className="flex flex-col gap-1">
              {overflowing.map((mask) => (
                <li key={mask}>
                  <span className="font-medium">
                    <RegionName spec={spec} mask={mask} />:
                  </span>{" "}
                  <span className="font-mono">
                    <Elements elements={regions.get(mask)!.elements} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {highlighted.length > 0 && (
          <ul aria-hidden="true" className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="set-key">
            {highlighted.map((mask) => {
              const tone = state.tones.get(mask)!;
              return (
                <li key={mask} className="flex items-baseline gap-1" data-tone={tone}>
                  <span className="font-medium">{TONES[tone].word}:</span>
                  <span>
                    <RegionName spec={spec} mask={mask} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {state.variables.length > 0 && (
          <dl className="flex flex-wrap gap-2">
            {state.variables.map((v, i) => (
              <div key={i} className="bg-muted flex gap-1 rounded-sm px-2 py-0.5 font-mono text-xs">
                <dt>
                  <Inline text={v.name} />
                </dt>
                <dd>
                  = <Inline text={String(v.value)} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {stepCount > 0 && (
          <>
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
                Step {index + 1} of {stepCount}
              </Badge>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
