import type { SetDiagramHighlight, SetDiagramSpec } from "@mivra/protocol";
import { Fragment, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { FRAME_INSET, ROW_HEIGHT, VENN_LAYOUTS, chooseRegionFit, regionMasks, regionPath, slotBox, type RegionFit, type RegionSlot, type Size, type VennLayout } from "./set-diagram-geometry.js";
import { ScrollableText, StepperControls, useStepper } from "./stepper.js";

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

/** Text screen readers get elsewhere. If it's too wide it must still be reachable, so the box stays out of what's hidden. */
function SeenOnly({ children }: { children: ReactNode }) {
  return (
    <ScrollableText>
      <span aria-hidden="true">{children}</span>
    </ScrollableText>
  );
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

const regionTotal = (region: Region) => region.count ?? region.elements.length;

function RegionSize({ total }: { total: number }) {
  return <span className="whitespace-nowrap">n = {total}</span>;
}

/** A region's elements, and its size as `n = ...` when that isn't simply how many are listed, so a count never reads as an element. */
function RegionContents({ region }: { region: Region }) {
  const total = regionTotal(region);
  if (region.elements.length === 0) return <RegionSize total={total} />;
  return (
    <>
      <Elements elements={region.elements} />
      {total !== region.elements.length && (
        <>
          {" "}
          (<RegionSize total={total} />)
        </>
      )}
    </>
  );
}

/** A region's box in the drawing, centred on its slot. */
function RegionBox({ slot, layout, children, ...attributes }: { slot: RegionSlot; layout: VennLayout; children: ReactNode; [attribute: `data-${string}`]: unknown }) {
  const percent = (value: number, of: number) => `${(value / of) * 100}%`;
  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center text-center font-mono text-xs leading-4"
      style={{ left: percent(slot.x, layout.width), top: percent(slot.y, layout.height), width: percent(slot.width, layout.width), height: percent(slot.rows * ROW_HEIGHT, layout.height) }}
      {...attributes}
    >
      <span className="bg-card/85 rounded-sm px-0.5">{children}</span>
    </div>
  );
}

/** A probe's rendered size. A formula too wide for its box scrolls inside it, so what's scrolled out of view counts too. */
function renderedSize(probe: Element): Size {
  const { width, height } = probe.getBoundingClientRect();
  const scrolled = [...probe.querySelectorAll(".katex")].reduce((sum, formula) => sum + Math.max(0, formula.scrollWidth - formula.clientWidth), 0);
  return { width: width + scrolled, height };
}

/** Whether a drawn label is wider than its corner, which is decided here rather than by a probe as labels are always shown. */
function isCutOff(label: Element): boolean {
  return [label, ...label.querySelectorAll(".katex")].some((box) => box.scrollWidth > box.clientWidth);
}

/**
 * Decides what each region shows from the hidden probes `Diagram` renders, which lay out like the real contents.
 * This runs before paint, and again before paint on each change of width or when fonts arrive.
 * Without layout, as in jsdom, nothing is measured and every region shows its contents.
 */
function useRegionFits(spec: SetDiagramSpec, layout: VennLayout): [RefObject<HTMLDivElement | null>, ReadonlyMap<number, RegionFit>, readonly string[]] {
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState<ReadonlyMap<number, RegionFit>>(new Map());
  const [cutOff, setCutOff] = useState<readonly string[]>([]);

  useLayoutEffect(() => {
    const root = ref.current!;
    let measuredWidth = 0;
    const measure = () => {
      measuredWidth = root.getBoundingClientRect().width;
      if (measuredWidth === 0) return;
      const next = new Map<number, RegionFit>();
      for (const mask of drawnMasks(spec)) {
        const contents = root.querySelector(`[data-probe="contents"][data-mask="${mask}"] > span`);
        const marker = root.querySelector(`[data-probe="marker"][data-mask="${mask}"] > span`);
        if (contents && marker) next.set(mask, chooseRegionFit(slotBox(layout, layout.slots[mask]!, measuredWidth), renderedSize(contents), renderedSize(marker)));
      }
      setFits((current) => (next.size === current.size && [...next].every(([mask, fit]) => current.get(mask) === fit) ? current : next));
      const labels = [...root.querySelectorAll<HTMLElement>("[data-label]")].filter(isCutOff).map((label) => label.dataset.label!);
      setCutOff((current) => (current.join() === labels.join() ? current : labels));
    };
    measure();
    // The drawing's width doesn't depend on what's decided here, so this can't feed back into itself.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (root.getBoundingClientRect().width !== measuredWidth) flushSync(measure);
    });
    observer?.observe(root);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [spec, layout]);

  return [ref, fits, cutOff];
}

const LABEL_PLACES = ["Top left", "Top right", "Bottom left"];

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

function Diagram({ spec, layout, tones, fits, drawing }: { spec: SetDiagramSpec; layout: VennLayout; tones: Map<number, Tone>; fits: ReadonlyMap<number, RegionFit>; drawing: RefObject<HTMLDivElement | null> }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = { hatch: `${id}-hatch`, dots: `${id}-dots`, clip: `${id}-clip` };
  const { width, height, radius, circles, slots } = layout;
  const masks = drawnMasks(spec);
  const regions = new Map(spec.regions.map((r) => [regionMask(spec, r.in), r]));

  return (
    <div ref={drawing} className="relative mx-auto w-full max-w-md" style={{ aspectRatio: `${width} / ${height}` }} aria-hidden="true" inert data-testid="set-diagram">
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
        <div key={set.id} className="absolute text-xs leading-4 font-medium" style={labelPosition(i, spec.sets.length)} data-testid="set-label" data-label={i}>
          <span className="bg-card/85 rounded-sm px-0.5">
            <Inline text={set.label} />
          </span>
        </div>
      ))}
      {spec.universe !== undefined && (
        <div className="text-muted-foreground absolute bottom-[1.5%] left-1/2 w-[36%] -translate-x-1/2 text-center text-xs leading-4" data-testid="set-universe-label" data-label="universe">
          <span className="bg-card/85 rounded-sm px-0.5">
            <Inline text={spec.universe} />
          </span>
        </div>
      )}
      {masks.map((mask) => {
        const region = regions.get(mask);
        if (!region) return null;
        const fit = fits.get(mask) ?? "contents";
        return (
          <RegionBox key={mask} slot={slots[mask]!} layout={layout} data-testid="set-elements" data-mask={mask} data-fit={fit}>
            {regionTotal(region) === 0 ? "∅" : fit === "contents" ? <RegionContents region={region} /> : fit === "marker" ? <><RegionSize total={regionTotal(region)} /> ↓</> : "↓"}
          </RegionBox>
        );
      })}
      {/* Clipped, because what's being measured can be much bigger than the drawing. */}
      <div className="invisible absolute inset-0 overflow-hidden">
        {masks.map((mask) => {
          const region = regions.get(mask);
          if (!region || regionTotal(region) === 0) return null;
          return (
            <Fragment key={mask}>
              <RegionBox slot={slots[mask]!} layout={layout} data-probe="contents" data-mask={mask}>
                <RegionContents region={region} />
              </RegionBox>
              <RegionBox slot={slots[mask]!} layout={layout} data-probe="marker" data-mask={mask}>
                <RegionSize total={regionTotal(region)} /> ↓
              </RegionBox>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

export function SetDiagram({ view }: ArtifactProps<"set_diagram">) {
  const { spec } = view;
  const stepCount = spec.steps?.length ?? 0;
  const stepper = useStepper(stepCount);
  const { index } = stepper;
  const titleId = useId();
  const kindId = useId();

  const layout = VENN_LAYOUTS[spec.sets.length]!;
  const state = setDiagramStateAt(spec, index);
  const masks = drawnMasks(spec);
  const regions = new Map(spec.regions.map((r) => [regionMask(spec, r.in), r]));
  const highlighted = masks.filter((mask) => state.tones.has(mask));
  const [drawing, fits, cutOff] = useRegionFits(spec, layout);
  const overflowing = masks.filter((mask) => (fits.get(mask) ?? "contents") !== "contents");

  return (
    <Card role="region" aria-labelledby={`${titleId} ${kindId}`} {...(stepCount > 0 ? { tabIndex: 0, onKeyDown: stepper.onKeyDown } : {})} className="whitespace-normal">
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
        <CardDescription id={kindId}>Set diagram</CardDescription>
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
        </ul>
        <Diagram spec={spec} layout={layout} tones={state.tones} fits={fits} drawing={drawing} />
        {/* These three are for the eye: the description and the announcement say the same, so they're not lists to a screen reader. */}
        {(overflowing.length > 0 || cutOff.length > 0) && (
          <div className="flex flex-col gap-1 text-xs" data-testid="set-overflow">
            <p aria-hidden="true" className="text-muted-foreground">
              ↓ Doesn't fit in the diagram:
            </p>
            {cutOff.map((label) => (
              <SeenOnly key={label}>
                <span className="font-medium">{label === "universe" ? "Universe" : `${LABEL_PLACES[Number(label)]} label`}:</span>{" "}
                <Inline text={label === "universe" ? spec.universe! : spec.sets[Number(label)]!.label} />
              </SeenOnly>
            ))}
            {overflowing.map((mask) => (
              <SeenOnly key={mask}>
                <span className="font-medium">
                  <RegionName spec={spec} mask={mask} />:
                </span>{" "}
                <span className="font-mono">
                  <RegionContents region={regions.get(mask)!} />
                </span>
              </SeenOnly>
            ))}
          </div>
        )}
        {highlighted.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="set-key">
            {highlighted.map((mask) => {
              const tone = state.tones.get(mask)!;
              return (
                <div key={mask} className="max-w-full min-w-0" data-tone={tone}>
                  <SeenOnly>
                    <span className="font-medium">{TONES[tone].word}:</span> <RegionName spec={spec} mask={mask} />
                  </SeenOnly>
                </div>
              );
            })}
          </div>
        )}
        {state.variables.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="set-variables">
            {state.variables.map((v, i) => (
              <div key={i} className="bg-muted max-w-full min-w-0 rounded-sm px-2 py-0.5 font-mono text-xs">
                <SeenOnly>
                  <Inline text={v.name} /> = <Inline text={String(v.value)} />
                </SeenOnly>
              </div>
            ))}
          </div>
        )}
        {stepCount > 0 && (
          <>
            {/* Always there, and always different from one step to the next, so every step is announced. The other visible versions of what's in it are hidden from screen readers. */}
            <div aria-live="polite" aria-atomic="true" data-testid="set-announcement">
              <span className="sr-only">
                Step {index + 1} of {stepCount}:{" "}
              </span>
              <div data-testid="set-explanation">
                <ScrollableText>
                  <MathText text={state.explanation} mode="math" />
                </ScrollableText>
              </div>
              <span className="sr-only">
                {highlighted.length === 0 && "Nothing highlighted. "}
                {highlighted.map((mask) => (
                  <Fragment key={mask}>
                    {TONES[state.tones.get(mask)!].word}: <RegionName spec={spec} mask={mask} />.{" "}
                  </Fragment>
                ))}
                {state.variables.map((v, i) => (
                  <Fragment key={i}>
                    <Inline text={v.name} /> = <Inline text={String(v.value)} />.{" "}
                  </Fragment>
                ))}
              </span>
            </div>
            <StepperControls stepper={stepper} play />
          </>
        )}
      </CardContent>
    </Card>
  );
}
