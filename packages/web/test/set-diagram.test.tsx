import type { SetDiagramSpec } from "@mivra/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { regionMask, setDiagramStateAt } from "../src/artifacts/SetDiagram.js";
import { ROW_HEIGHT, VENN_LAYOUTS, chooseRegionFit, isInRegion, regionMasks, regionPath, slotBox } from "../src/artifacts/set-diagram-geometry.js";
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
      // An arrow, the least a region can show, fits at the narrowest the diagram is drawn.
      expect(chooseRegionFit(slotBox(layout, slot, 230), { width: 11.2, height: 16 }, { width: 11.2, height: 16 })).toBe("contents");
    }
  });
});

describe("chooseRegionFit", () => {
  const box = { width: 40, height: 16 };
  it("shows the fullest thing that stays inside the box, in both directions", () => {
    expect(chooseRegionFit(box, { width: 40, height: 16 }, { width: 30, height: 16 })).toBe("contents");
    expect(chooseRegionFit(box, { width: 53, height: 16 }, { width: 30, height: 16 })).toBe("marker");
    expect(chooseRegionFit(box, { width: 30, height: 96 }, { width: 30, height: 16 })).toBe("marker");
    expect(chooseRegionFit(box, { width: 53, height: 16 }, { width: 41, height: 16 })).toBe("arrow");
    expect(chooseRegionFit(box, { width: 53, height: 16 }, { width: 30, height: 32 })).toBe("arrow");
  });

  it("gives a slot more room the wider the diagram is drawn", () => {
    const layout = VENN_LAYOUTS[3]!;
    const threeNumbers = { width: 54.4, height: 16 };
    const slot = layout.slots[0b011]!;
    const at = (drawn: number) => chooseRegionFit(slotBox(layout, slot, drawn), threeNumbers, { width: 11.2, height: 16 });
    expect(at(230)).toBe("marker");
    expect(at(448)).toBe("contents");
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
    expect(document.querySelector("dl")?.textContent).toContain("size");
    expect(screen.getByTestId("set-explanation").textContent).toBe("Look at the overlap.");
    next();
    expect(tones()).toEqual([]);
    expect(document.querySelector("dl")).toBeNull();
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
  });

  describe("the step announcement", () => {
    const announcement = () => screen.getByTestId("set-announcement");

    it("carries the step, explanation, highlight meanings and variables together, in one atomic polite region", () => {
      renderDiagram();
      expect(announcement().getAttribute("aria-live")).toBe("polite");
      expect(announcement().getAttribute("aria-atomic")).toBe("true");
      expect(announcement().textContent).toContain("Step 1 of 3: Look at the overlap.");
      expect(announcement().textContent).toContain("Focus: in A and B, not C.");
      expect(announcement().textContent).toContain("Ruled out: outside A, B and C.");
      expect(announcement().textContent).toContain("size = 2.");
      next();
      expect(announcement().textContent).toContain("Nothing highlighted.");
      expect(announcement().textContent).not.toContain("Focus:");
      next();
      expect(announcement().textContent).toContain("Done: in A, B and C.");
    });

    it("stays the same element and changes between steps that have the same explanation", () => {
      renderDiagram(
        withSpec({
          steps: [
            { explanation: "Same words.", highlights: [{ in: ["a"] }] },
            { explanation: "Same words.", highlights: [{ in: ["b"] }] },
          ],
        }),
      );
      const before = announcement();
      const first = before.textContent;
      next();
      expect(announcement()).toBe(before);
      expect(before.textContent).not.toBe(first);
      expect(before.textContent).toContain("Step 2 of 2: Same words.");
      expect(before.textContent).toContain("Focus: in B, not A or C.");
    });

    it("is the only live region, and screen readers don't get its contents twice", () => {
      renderDiagram();
      expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
      expect(screen.getByTestId("set-explanation").getAttribute("aria-hidden")).toBe("true");
      expect(document.querySelector("dl")?.getAttribute("aria-hidden")).toBe("true");
    });

    it("isn't there without steps", () => {
      renderDiagram(withSpec({ steps: undefined }));
      expect(screen.queryByTestId("set-announcement")).toBeNull();
    });
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
    expect(slot(0b100)).toBe("n = 7");
    expect(slot(0b111)).toBe("∅");
    expect(slot(0b010)).toBeUndefined();
  });

  it("marks a count so it can't be read as an element", () => {
    renderDiagram(
      withSpec({
        regions: [
          { in: ["a"], elements: [1] },
          { in: ["b"], elements: [], count: 1 },
          { in: ["c"], elements: [2], count: 9 },
          { in: ["a", "b"], elements: [3, 4], count: 2 },
        ],
        steps: undefined,
      }),
    );
    const slot = (mask: number) => screen.getAllByTestId("set-elements").find((e) => e.getAttribute("data-mask") === String(mask))?.textContent;
    expect(slot(0b001)).toBe("1");
    expect(slot(0b010)).toBe("n = 1");
    expect(slot(0b100)).toBe("2 (n = 9)");
    expect(slot(0b011)).toBe("3, 4");
  });

  describe("with layout", () => {
    afterEach(() => vi.restoreAllMocks());

    /** A stand-in for the browser's layout: one unwrapped line of 12px mono, in a diagram `drawn` pixels wide. */
    function layOut(drawn: number) {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const width = this.dataset.testid === "set-diagram" ? drawn : (this.textContent?.length ?? 0) * 7.2 + 4;
        return { width, height: 16 } as DOMRect;
      });
    }
    const slot = (mask: number) => screen.getAllByTestId("set-elements").find((e) => e.getAttribute("data-mask") === String(mask))!;
    const regions = [
      { in: ["a", "b", "c"], elements: Array.from({ length: 30 }, (_, i) => i + 100) },
      { in: ["a", "b"], elements: [4, 5, 6] },
      { in: ["a", "c"], elements: [], count: 1_000_000 },
      { in: ["b"], elements: [7] },
    ];

    it("moves what doesn't fit to the list, leaving the fullest marker that does", () => {
      layOut(230);
      renderDiagram(withSpec({ regions, steps: undefined }));
      expect(slot(0b111).textContent).toBe("↓");
      expect(slot(0b101).textContent).toBe("↓");
      expect(slot(0b010).textContent).toBe("7");
      const list = screen.getByTestId("set-overflow").textContent;
      expect(list).toContain("in A, B and C:");
      expect(list).toContain("129");
      expect(list).toContain("n = 1000000");
      expect(list).not.toContain("in B, not A or C");
      expect(description()).toContain("129");
    });

    it("shows small examples in place when the drawing has room", () => {
      layOut(448);
      renderDiagram(withSpec({ regions, steps: undefined }));
      expect(slot(0b011).textContent).toBe("4, 5, 6");
      expect(screen.getByTestId("set-overflow").textContent).not.toContain("in A and B, not C");
    });

    it("counts a formula's scrolled-out width as not fitting", () => {
      layOut(230);
      const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
      renderDiagram(withSpec({ regions: [{ in: ["a", "b"], elements: ["$x$"] }], steps: undefined }));
      expect(scrollWidth).toHaveBeenCalled();
      expect(slot(0b011).getAttribute("data-fit")).not.toBe("contents");
    });
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
    expect(screen.getByRole("button", { name: /prev/i }).getAttribute("aria-disabled")).toBe("true");
  });
});
