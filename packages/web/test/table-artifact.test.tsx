import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { tableStateAt } from "../src/artifacts/TableArtifact.js";
import { relationMatrix, truthTable } from "./fixtures.js";

const renderTable = (data: unknown) => render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
const cells = () => screen.getAllByTestId("table-cell");
const texts = () => cells().map((c) => c.textContent);
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));
const prev = () => fireEvent.click(screen.getByRole("button", { name: /prev/i }));
const counter = () => screen.getByTestId("step-counter").textContent;
const live = () => screen.getByTestId("table-live");

describe("tableStateAt", () => {
  it("carries cell changes forward and keeps highlights to their own step", () => {
    expect(tableStateAt(truthTable.spec, 0).rows[0]).toEqual([true, true, ""]);
    expect(tableStateAt(truthTable.spec, 1).rows[0]).toEqual([true, true, true]);
    expect(tableStateAt(truthTable.spec, 2).rows[0]).toEqual([true, true, true]);
    expect(tableStateAt(truthTable.spec, 2).highlight).toEqual([{ row: 1, column: 2, tone: "muted" }]);
    // The spec itself is never changed.
    expect(truthTable.spec.rows[0]).toEqual([true, true, ""]);
  });
});

describe("TableArtifact", () => {
  // The first render and role query in a file take far longer than the rest, so a busy machine can time that test out.
  beforeAll(() => {
    renderTable(truthTable);
    next();
    cleanup();
  });
  afterEach(() => void vi.useRealTimers());

  it("persists changed cells and shows booleans as T and F", () => {
    renderTable(truthTable);
    expect(texts()).toEqual(["T", "T", "", "T", "F", ""]);
    next();
    expect(texts()).toEqual(["T", "T", "T", "T", "F", ""]);
    next();
    expect(texts()).toEqual(["T", "T", "T", "T", "F", "F"]);
    prev();
    expect(texts()).toEqual(["T", "T", "T", "T", "F", ""]);
  });

  it("applies highlights to their own step only, with the tone given", () => {
    renderTable(truthTable);
    const tones = () => cells().map((c) => c.getAttribute("data-tone"));
    expect(tones()).toEqual(["active", "done", null, "active", "done", null]);
    next();
    expect(tones()).toEqual(["active", "active", "active", null, null, null]);
    next();
    expect(tones()).toEqual([null, null, null, null, null, "muted"]);
  });

  it("lets a later highlight win where they overlap", () => {
    const steps = [{ explanation: "x", highlight: [{ row: 0 }, { row: 0, column: 1, tone: "done" as const }] }];
    renderTable({ ...truthTable, spec: { ...truthTable.spec, steps } });
    expect(cells()[0]!.getAttribute("data-tone")).toBe("active");
    expect(cells()[1]!.getAttribute("data-tone")).toBe("done");
  });

  it("uses neutral tokens for active, success for done, and no amber or raw colours", () => {
    renderTable(truthTable);
    const active = cells()[0]!.className;
    expect(active).toContain("bg-secondary");
    expect(active).toContain("ring-foreground");
    expect(active).not.toMatch(/accent|primary|amber|#[0-9a-f]{3}/i);
    expect(cells()[1]!.className).toContain("bg-success/15");
    // Muted shares active's background in both themes, so the outline has to tell them apart.
    next();
    next();
    expect(cells()[5]!.className).toContain("bg-muted");
    expect(cells()[5]!.className).not.toContain("ring");
  });

  it("is a real table with header scopes and a caption", () => {
    renderTable(relationMatrix);
    const table = screen.getByRole("table");
    expect(table.querySelector("caption")?.textContent).toContain("R");
    const columns = within(table).getAllByRole("columnheader");
    expect(columns).toHaveLength(2);
    expect(columns.every((c) => c.getAttribute("scope") === "col")).toBe(true);
    const rows = within(table).getAllByRole("rowheader");
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.getAttribute("scope") === "row")).toBe(true);
    // A corner cell keeps the column headers over their own columns.
    expect(table.querySelector("thead tr")!.children).toHaveLength(3);
  });

  it("renders formulas in headers and cells, and keeps everything else literal", () => {
    renderTable(relationMatrix);
    expect(screen.getAllByRole("columnheader")[0]!.querySelector(".katex")).not.toBeNull();
    expect(screen.getAllByRole("rowheader")[0]!.querySelector(".katex")).not.toBeNull();
    expect(texts()).toEqual(["1", "2*3*4", "|x|", "F"]);
    expect(cells()[1]!.querySelector("em")).toBeNull();
  });

  it("is static without steps: no controls, no explanation", () => {
    const { container } = renderTable(relationMatrix);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("table-live")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByRole("region").hasAttribute("tabindex")).toBe(false);
  });

  it("describes highlights and changes for screen readers", () => {
    renderTable(truthTable);
    const description = () => screen.getByTestId("table-description").textContent;
    expect(description()).toContain("Highlighted: column 1");
    expect(description()).toContain("Done: column 2");
    next();
    expect(description()).toContain("Highlighted: row 1");
    expect(description()).toContain("Changed row 1, column 3 to T");
    next();
    expect(description()).toContain("Ruled out: row 2, column 3");
    expect(description()).toContain("Changed row 2, column 3 to F");
  });

  it("announces the explanation, and renders its formula", () => {
    renderTable(truthTable);
    const region = live();
    expect(region.textContent).toContain("Read the inputs.");
    next();
    next();
    expect(region.textContent).toContain("One is false");
    expect(region.querySelector(".katex")).not.toBeNull();
  });

  it("announces each step whole from one persistent region, even when the explanations match", () => {
    const steps = [
      { explanation: "Fill in a cell.", cells: [{ row: 0, column: 2, value: true }] },
      { explanation: "Fill in a cell.", highlight: [{ row: 1 }], cells: [{ row: 1, column: 2, value: false }] },
    ];
    renderTable({ ...truthTable, spec: { ...truthTable.spec, steps } });
    const region = live();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("Step 1 of 2. Fill in a cell. Changed row 1, column 3 to T.");
    next();
    expect(live()).toBe(region);
    expect(region.textContent).toBe("Step 2 of 2. Fill in a cell. Highlighted: row 2. Changed row 2, column 3 to F.");
  });

  it("keeps the table out of the live region, and says the step number only once", () => {
    renderTable(truthTable);
    expect(live().contains(screen.getByRole("table"))).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("makes a formula box a tab stop only when it overflows", () => {
    renderTable(truthTable);
    const box = live().querySelector<HTMLElement>('[data-testid="step-scroll"]')!;
    expect(box.hasAttribute("tabindex")).toBe(false);
    vi.spyOn(box, "scrollWidth", "get").mockReturnValue(500);
    vi.spyOn(box, "clientWidth", "get").mockReturnValue(100);
    next();
    expect(box.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(counter()).toBe("Step 2 of 3");
  });

  it("steps with the arrow keys, except while the table scroll box has focus", () => {
    renderTable(truthTable);
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(counter()).toBe("Step 2 of 3");
    fireEvent.keyDown(screen.getByTestId("table-scroll"), { key: "ArrowRight" });
    expect(counter()).toBe("Step 2 of 3");
    expect(screen.getByTestId("table-scroll").getAttribute("tabindex")).toBe("0");
  });

  it("keeps focus on next at the last step, and stays within bounds", () => {
    renderTable(truthTable);
    const nextButton = screen.getByRole("button", { name: /next/i }) as HTMLButtonElement;
    nextButton.focus();
    next();
    next();
    expect(nextButton.getAttribute("aria-disabled")).toBe("true");
    expect(nextButton.disabled).toBe(false);
    expect(document.activeElement).toBe(nextButton);
    next();
    expect(counter()).toBe("Step 3 of 3");
  });

  it("plays to the end and stops", () => {
    vi.useFakeTimers();
    renderTable(truthTable);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    for (let i = 0; i < 5; i++) act(() => void vi.advanceTimersByTime(2000));
    expect(counter()).toBe("Step 3 of 3");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("shows a placeholder for a table the client's schema rejects", () => {
    renderTable({ ...truthTable, spec: { ...truthTable.spec, rows: [[true]] } });
    expect(screen.getByText("Can't display this item.")).toBeTruthy();
  });
});
