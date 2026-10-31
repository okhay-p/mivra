import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { tableStateAt } from "../src/artifacts/TableArtifact.js";
import { relationMatrix, truthTable } from "./fixtures.js";

const renderTable = (data: unknown) => render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
const cells = () => screen.getAllByTestId("table-cell");
const texts = () => cells().map((c) => c.textContent);
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));
const prev = () => fireEvent.click(screen.getByRole("button", { name: /prev/i }));

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

  it("uses success, not amber, for done and no raw colours", () => {
    renderTable(truthTable);
    expect(cells()[1]!.className).toContain("bg-success/15");
    expect(cells()[0]!.className).not.toMatch(/amber|#[0-9a-f]{3}/i);
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
    const { container } = renderTable(truthTable);
    const live = container.querySelector("[aria-live=polite]")!;
    expect(live.textContent).toContain("Read the inputs.");
    next();
    next();
    expect(live.textContent).toContain("One is false");
    expect(live.querySelector(".katex")).not.toBeNull();
  });

  it("steps with the arrow keys, except while the table scroll box has focus", () => {
    renderTable(truthTable);
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toBe("Step 2 of 3");
    fireEvent.keyDown(screen.getByTestId("table-scroll"), { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toBe("Step 2 of 3");
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
    expect(screen.getByRole("status").textContent).toBe("Step 3 of 3");
  });

  it("plays to the end and stops", () => {
    vi.useFakeTimers();
    renderTable(truthTable);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    for (let i = 0; i < 5; i++) act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole("status").textContent).toBe("Step 3 of 3");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("shows a placeholder for a table the client's schema rejects", () => {
    renderTable({ ...truthTable, spec: { ...truthTable.spec, rows: [[true]] } });
    expect(screen.getByText("Can't display this item.")).toBeTruthy();
  });
});
