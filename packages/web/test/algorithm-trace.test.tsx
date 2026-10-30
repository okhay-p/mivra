import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { trace } from "./fixtures.js";

const renderTrace = () => render(<ArtifactPart data={trace} replyInProgress={false} onUpdate={() => {}} />);
const cells = () => screen.getAllByTestId("trace-cell").map((c) => c.firstChild?.textContent);
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));
const prev = () => fireEvent.click(screen.getByRole("button", { name: /prev/i }));

describe("AlgorithmTrace", () => {
  it("persists values across steps but not pointers, ranges or variables", () => {
    renderTrace();
    expect(cells()).toEqual(["3", "1", "2"]);
    expect(screen.getByTestId("trace-pointer").textContent).toContain("i");
    expect(screen.getByTestId("trace-range").textContent).toBe("pair");
    expect(screen.getByText("swaps")).toBeTruthy();
    expect(screen.getByText("Compare the first two.")).toBeTruthy();

    next();
    expect(cells()).toEqual(["1", "3", "2"]);
    expect(screen.queryAllByTestId("trace-pointer")).toHaveLength(0);
    expect(screen.queryAllByTestId("trace-range")).toHaveLength(0);
    expect(screen.queryByText("swaps")).toBeNull();

    next();
    // Step 3 sets no values, so step 2's swap still shows.
    expect(cells()).toEqual(["1", "3", "2"]);
    const pointer = screen.getByTestId("trace-pointer");
    expect(pointer.style.gridColumn).toBe("2");
    expect(screen.getByText("Move on.")).toBeTruthy();
  });

  it("keeps prev and next within bounds", () => {
    renderTrace();
    const counter = () => screen.getByText(/^Step \d+ of 3$/).textContent;
    expect(counter()).toBe("Step 1 of 3");
    expect((screen.getByRole("button", { name: /prev/i }) as HTMLButtonElement).disabled).toBe(true);
    prev();
    expect(counter()).toBe("Step 1 of 3");

    next();
    next();
    expect(counter()).toBe("Step 3 of 3");
    expect((screen.getByRole("button", { name: /next/i }) as HTMLButtonElement).disabled).toBe(true);
    next();
    expect(counter()).toBe("Step 3 of 3");
  });

  it("steps with the arrow keys", () => {
    renderTrace();
    const region = screen.getByRole("region", { name: /Swap demo/ });
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  });

  it("plays to the end and stops", () => {
    vi.useFakeTimers();
    renderTrace();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    // Each step schedules the next once it has rendered.
    for (let i = 0; i < 5; i++) act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" }).getAttribute("aria-pressed")).toBe("false");
  });
});
