import type { SetDiagramSpec } from "@mivra/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { regionContents, regionMask, setDiagramStateAt } from "../src/artifacts/SetDiagram.js";
import { ROW_HEIGHT, VENN_LAYOUTS, isInRegion, regionMasks, regionPath, slotCapacity } from "../src/artifacts/set-diagram-geometry.js";
import { venn } from "./fixtures.js";

const renderDiagram = (data: object = venn) => render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));
const tones = () =>
  screen
    .getAllByTestId("set-region")
    .filter((g) => g.getAttribute("data-tone") !== "none")
    .map((g) => `${g.getAttribute("data-mask")}:${g.getAttribute("data-tone")}`);
const description = () => screen.getByTestId("set-description").textContent;
const withSpec = (spec: Partial<SetDiagramSpec>) => ({ ...venn, spec: { ...venn.spec, ...spec } });

describe("set diagram geometry", () => {
  it.each([1, 2, 3])("draws a distinct closed shape for each of the regions of %i sets", (sets) => {
    const layout = VENN_LAYOUTS[sets]!;
    const paths = regionMasks(sets).map((mask) => regionPath(layout, mask));
    expect(paths).toHaveLength(2 ** sets);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path).toMatch(/^M.*Z$/);
  });

  it("gives the outside region its frame and a hole, and the middle three arcs", () => {
    const layout = VENN_LAYOUTS[3]!;
    expect(regionPath(layout, 0).match(/M/g)).toHaveLength(2);
    expect(regionPath(layout, 0b111).match(/A/g)).toHaveLength(3);
  });

  it.each([1, 2, 3])("keeps every slot's box inside its region, for %i sets", (sets) => {
    const layout = VENN_LAYOUTS[sets]!;
    for (const mask of regionMasks(sets)) {
      const slot = layout.slots[mask]!;
      const [dx, dy] = [slot.width / 2, (slot.rows * ROW_HEIGHT) / 2];
      for (const [x, y] of [[slot.x - dx, slot.y - dy], [slot.x + dx, slot.y - dy], [slot.x - dx, slot.y + dy], [slot.x + dx, slot.y + dy]]) {
        expect(isInRegion(layout, mask, { x: x!, y: y! }), `mask ${mask} at ${x},${y}`).toBe(true);
        expect(x! > 0 && x! < layout.width && y! > 0 && y! < layout.height).toBe(true);
      }
      expect(slotCapacity(slot)).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("regionMask", () => {
  it("maps each region and any ordering of it to its own mask", () => {
    const { spec } = venn;
    const regions = [[], ["a"], ["b"], ["c"], ["a", "b"], ["a", "c"], ["b", "c"], ["a", "b", "c"]];
    expect(new Set(regions.map((r) => regionMask(spec, r))).size).toBe(8);
    expect(regionMask(spec, ["c", "b", "a"])).toBe(regionMask(spec, ["a", "b", "c"]));
  });
});

describe("SetDiagram", () => {
  it("highlights only the current step's regions, defaulting the tone to active", () => {
    expect(setDiagramStateAt(venn.spec, 0).tones).toEqual(new Map([[0b011, "active"], [0, "muted"]]));
    expect(setDiagramStateAt(venn.spec, 1).tones.size).toBe(0);
    renderDiagram();
    expect(tones()).toEqual(["3:active", "0:muted"]);
    expect(screen.getByText("size")).toBeTruthy();
    expect(screen.getByText("Look at the overlap.")).toBeTruthy();
    next();
    expect(tones()).toEqual([]);
    expect(screen.queryByText("size")).toBeNull();
    next();
    expect(tones()).toEqual(["7:done"]);
  });

  it("draws every region of 3 sets plus the universe, and leaves outside out without one", () => {
    const { unmount } = renderDiagram();
    expect(screen.getAllByTestId("set-region")).toHaveLength(8);
    expect(screen.getByTestId("set-universe")).toBeTruthy();
    unmount();
    const { universe: _, ...rest } = venn.spec;
    renderDiagram({ ...venn, spec: { ...rest, regions: [], steps: undefined } });
    expect(screen.getAllByTestId("set-region")).toHaveLength(7);
    expect(screen.queryByTestId("set-universe")).toBeNull();
  });

  it("describes sets, region contents and the step's highlights in words", () => {
    renderDiagram();
    expect(description()).toContain("Set: A");
    expect(description()).toContain("Universe: U");
    expect(description()).toContain("in A, not B or C: 1, 2");
    expect(description()).toContain("in A and B, not C: 3, 5");
    expect(description()).toContain("in A, B and C: empty");
    expect(description()).toContain("in C, not A or B: 7 in total");
    expect(description()).toContain("outside A, B and C: 9");
    expect(description()).toContain("Focus: in A and B, not C");
    expect(description()).toContain("Ruled out: outside A, B and C");
    next();
    expect(description()).not.toContain("Focus:");
    next();
    expect(description()).toContain("Done: in A, B and C");
  });

  it("hides the drawing from screen readers, and puts the tones in visible words too", () => {
    renderDiagram();
    expect(screen.getByTestId("set-diagram").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("set-key").textContent).toContain("Focus:in A and B, not C");
  });

  it("shows elements, counts and the empty set in their regions", () => {
    renderDiagram();
    const slot = (mask: number) => screen.getAllByTestId("set-elements").find((e) => e.getAttribute("data-mask") === String(mask))?.textContent;
    expect(slot(0b011)).toBe("3, 5");
    expect(slot(0b100)).toBe("7");
    expect(slot(0b111)).toBe("∅");
    expect(slot(0b010)).toBeUndefined();
  });

  it("replaces elements that don't fit with a count, and lists them below", () => {
    expect(regionContents({ in: [], elements: [1, 2, 3] }, 7).kind).toBe("elements");
    expect(regionContents({ in: [], elements: [1, 2, 3, 4] }, 7)).toEqual({ kind: "overflow", total: 4 });
    expect(regionContents({ in: [], elements: [1], count: 9 }, 7)).toMatchObject({ kind: "elements", suffix: " (9)" });
    expect(regionContents(undefined, 7).kind).toBe("none");

    const elements = Array.from({ length: 30 }, (_, i) => i + 100);
    renderDiagram(withSpec({ regions: [{ in: ["a", "b", "c"], elements }] }));
    expect(screen.getByTestId("set-elements").textContent).toBe("30 ↓");
    expect(screen.getByTestId("set-overflow").textContent).toContain("in A, B and C:");
    expect(screen.getByTestId("set-overflow").textContent).toContain("129");
    expect(description()).toContain("129");
  });

  it("keeps labels literal apart from $...$", () => {
    renderDiagram(withSpec({ sets: [{ id: "a", label: "2*3*4 and $x^2$" }], regions: [], steps: undefined }));
    const label = screen.getByTestId("set-label");
    expect(label.textContent).toContain("2*3*4 and ");
    expect(label.querySelector(".katex")).toBeTruthy();
  });

  it("has no stepper without steps, and steps with the arrow keys when it has them", () => {
    const { unmount } = renderDiagram(withSpec({ steps: undefined }));
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
    unmount();
    renderDiagram();
    const region = screen.getByRole("region", { name: /Three sets/ });
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: /prev/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
