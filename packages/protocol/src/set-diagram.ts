import { z } from "zod";
import { TraceVariable } from "./algorithm-trace.js";

/**
 * set_diagram v1: a Venn diagram of up to 3 sets, with what each region contains and optional steps
 * that highlight regions. Covers union, intersection, complement, difference and inclusion-exclusion.
 *
 * A region is named by the set ids it is inside and is outside every other set, so with sets a, b and c,
 * `["a", "b"]` is "in a and b, not c", and `["b", "a"]` is the same region. `[]` is outside every set.
 * A region that isn't listed has no contents shown; a listed region with no elements and no count is empty.
 *
 * Highlights and variables do not persist: each step lists all of its own.
 */

const MAX_SETS = 3;
/** 2^3: every region of a 3-set diagram, including outside. */
const MAX_REGIONS = 8;
const MAX_ELEMENTS = 30;
const MAX_STEPS = 40;

const SetId = z.string().trim().min(1).max(24);
/** Text drawn in a tight spot in the diagram, so it stays on one line. */
const ONE_LINE = /^[^\n\r\v\f\u0085\u2028\u2029]*$/;
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(ONE_LINE, "must not contain line breaks");
const Element = z.union([z.number(), oneLine(24)]);

/** The same string for any ordering of the same set ids, so a region can be compared and looked up. */
export function setRegionKey(ids: readonly string[]): string {
  return JSON.stringify([...ids].sort());
}

const RegionIn = z.array(SetId).max(MAX_SETS);

export const SetDiagramSet = z
  .object({
    id: SetId.describe('Short id used to refer to this set, e.g. "a". Unique within the diagram.'),
    label: oneLine(32).describe('Shown next to the circle, e.g. "$A$" or "Multiples of 3", on one line. Only $...$ is a formula.'),
  })
  .strict();

export const SetDiagramRegion = z
  .object({
    in: RegionIn.describe('Ids of the sets this region is inside. It is outside all the others: with sets a, b, c, ["a","b"] means in a and b, not c. [] means outside every set and needs `universe`. No id twice.'),
    elements: z.array(Element).max(MAX_ELEMENTS).describe("What the region contains, each short and on one line. No element may appear twice, in this list or across regions, and 1 and \"1\" count as the same element. Empty if you only know the count, or the region is empty."),
    count: z
      .number()
      .int()
      .nonnegative()
      .max(1_000_000)
      .optional()
      .describe("How many elements the region has, when that's more than you list, e.g. for inclusion-exclusion. At least the number of elements listed."),
  })
  .strict();

export const SetDiagramHighlight = z
  .object({
    in: RegionIn.describe("The region to highlight, named like a region's `in`, with no id twice. Any region of the diagram can be highlighted, listed or not."),
    tone: z.enum(["active", "done", "muted"]).optional().describe("active = current focus, done = finished, muted = ruled out. Defaults to active."),
  })
  .strict();

export const SetDiagramStep = z
  .object({
    explanation: z.string().trim().min(1).max(500).describe("What this step shows, in one or two sentences."),
    highlights: z
      .array(SetDiagramHighlight)
      .max(MAX_REGIONS)
      .optional()
      .describe("All regions highlighted at this step, each at most once. They apply to this step only, not carried over: repeat any that still apply."),
    variables: z.array(TraceVariable).max(12).optional().describe("All running state at this step, e.g. |A ∪ B| so far. Not carried over from earlier steps."),
  })
  .strict();

export const SetDiagramSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    sets: z.array(SetDiagramSet).min(1).max(MAX_SETS).describe("The circles, 1 to 3."),
    universe: oneLine(24).optional().describe('Label of the rectangle around the sets, e.g. "$U$", on one line. Needed to show or highlight the region outside every set, such as a complement.'),
    regions: z.array(SetDiagramRegion).max(MAX_REGIONS).describe("What each region contains, each region at most once."),
    steps: z.array(SetDiagramStep).min(1).max(MAX_STEPS).optional().describe("Optional walk through the diagram. Omit for a static diagram."),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const ids = spec.sets.map((s) => s.id);
    spec.sets.forEach((set, i) => {
      if (ids.indexOf(set.id) !== i) ctx.addIssue({ code: "custom", path: ["sets", i, "id"], message: `duplicate set id "${set.id}"` });
    });

    /** Checks a list of region references, and reports any region named twice, whatever the order of its ids. */
    const checkRegions = (entries: readonly { in: string[] }[], path: (string | number)[]) => {
      const seen = new Set<string>();
      entries.forEach((entry, i) => {
        const at = [...path, i, "in"];
        entry.in.forEach((id, j) => {
          if (!ids.includes(id)) ctx.addIssue({ code: "custom", path: [...at, j], message: `unknown set "${id}"` });
          if (entry.in.indexOf(id) !== j) ctx.addIssue({ code: "custom", path: [...at, j], message: `set "${id}" is named twice` });
        });
        if (entry.in.length === 0 && spec.universe === undefined) {
          ctx.addIssue({ code: "custom", path: at, message: "the region outside every set needs `universe`" });
        }
        const key = setRegionKey(entry.in);
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: at, message: `region ${key} appears more than once` });
        seen.add(key);
      });
    };
    checkRegions(spec.regions, ["regions"]);
    spec.steps?.forEach((step, i) => checkRegions(step.highlights ?? [], ["steps", i, "highlights"]));

    // Regions don't overlap, so an element in two of them would teach something false.
    const placed = new Set<string>();
    spec.regions.forEach((region, i) => {
      region.elements.forEach((element, j) => {
        if (placed.has(String(element))) {
          ctx.addIssue({ code: "custom", path: ["regions", i, "elements", j], message: `element "${element}" appears more than once; regions don't overlap` });
        }
        placed.add(String(element));
      });
      if (region.count !== undefined && region.count < region.elements.length) {
        ctx.addIssue({ code: "custom", path: ["regions", i, "count"], message: `count ${region.count} is less than the ${region.elements.length} elements listed` });
      }
    });
  });

export type SetDiagramSpec = z.infer<typeof SetDiagramSpec>;
export type SetDiagramStep = z.infer<typeof SetDiagramStep>;
export type SetDiagramHighlight = z.infer<typeof SetDiagramHighlight>;
