import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { trace } from "./fixtures.js";

const renderTrace = (data: ComponentProps<typeof ArtifactPart>["data"] = trace) => render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
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

  it("describes pointers and ranges by position for screen readers", () => {
    renderTrace();
    const status = () => screen.getByTestId("trace-status").textContent;
    expect(screen.getByTestId("trace-description").textContent).toContain("index 0: 3, index 1: 1, index 2: 2");
    expect(status()).toContain("i points to index 0, value 3");
    expect(status()).toContain("pair covers indices 0 through 1");
    expect(status()).toContain("swaps = 0");
    next();
    next();
    expect(status()).toContain("i points to index 1, value 3");
    expect(status()).not.toContain("covers");
    expect(status()).not.toContain("swaps");
  });

  it("announces a step atomically from one live region, even when its explanation repeats", () => {
    const same = "Look again.";
    renderTrace({ ...trace, spec: { title: "Same", values: [1, 2], steps: [{ explanation: same }, { explanation: same }] } });
    const live = screen.getByTestId("trace-status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.textContent).toContain("Step 1 of 2.");
    next();
    expect(screen.getByTestId("trace-status")).toBe(live);
    expect(live.textContent).toContain("Step 2 of 2.");
    expect(live.textContent).toContain(same);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    // The visible counter would otherwise be read twice.
    expect(screen.getByText("Step 2 of 2").getAttribute("aria-hidden")).toBe("true");
  });

  it("announces which values a step changed, in either direction, and only then", () => {
    renderTrace({ ...trace, spec: { title: "Swap", values: [3, 1, 2], steps: [{ explanation: "Compare." }, { explanation: "Swap them.", values: [1, 3, 2] }, { explanation: "Move on." }] } });
    const status = () => screen.getByTestId("trace-status").textContent;
    expect(status()).not.toContain("is now");
    next();
    expect(status()).toContain("Index 0 is now 1. Index 1 is now 3.");
    expect(status()).not.toContain("Index 2");
    next();
    expect(status()).not.toContain("is now");
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
    expect(status()).not.toContain("is now");
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
    expect(status()).toContain("Index 0 is now 3. Index 1 is now 1.");
  });

  it("says what a range's tone means, and marks ranges and cells with neutral tokens, not amber", () => {
    renderTrace({
      ...trace,
      spec: {
        title: "Tones",
        values: [1, 2, 3],
        steps: [{ explanation: "x", pointers: [{ name: "i", index: 0 }], ranges: [{ start: 0, end: 0, label: "now" }, { start: 1, end: 1, label: "old", tone: "done" }, { start: 2, end: 2, label: "out", tone: "muted" }] }],
      },
    });
    const status = screen.getByTestId("trace-status").textContent;
    expect(status).toContain("now covers indices 0 through 0.");
    expect(status).toContain("old covers indices 1 through 1, done.");
    expect(status).toContain("out covers indices 2 through 2, ruled out.");
    const marked = [...screen.getAllByTestId("trace-range"), ...screen.getAllByTestId("trace-cell"), screen.getByTestId("trace-pointer")];
    for (const element of marked) expect(element.className).not.toMatch(/accent|primary/);
    expect(screen.getAllByTestId("trace-cell")[0]!.className).toContain("ring-foreground");
  });

  it("names the card by its rendered heading, not the title's source", () => {
    renderTrace({ ...trace, spec: { ...trace.spec, title: "Walk $v_1$" } });
    const region = screen.getByRole("region", { name: /Algorithm trace$/ });
    expect(region.getAttribute("aria-label")).toBeNull();
    const [title] = region.getAttribute("aria-labelledby")!.split(" ");
    expect(document.getElementById(title!)!.querySelector(".katex")).toBeTruthy();
  });

  it("scrolls a long title or explanation in its own box, which keeps its arrow keys", () => {
    renderTrace();
    const [title, explanation] = screen.getAllByTestId("step-scroll");
    expect(title!.closest("h3")).toBeTruthy();
    expect(explanation!.textContent).toBe("Compare the first two.");
    fireEvent.keyDown(explanation!, { key: "ArrowRight" });
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("keeps prev and next within bounds", () => {
    renderTrace();
    const counter = () => screen.getByText(/^Step \d+ of 3$/).textContent;
    expect(counter()).toBe("Step 1 of 3");
    // Not `disabled`, which would drop the focus of someone who has just stepped to the end.
    expect(screen.getByRole("button", { name: /prev/i }).getAttribute("aria-disabled")).toBe("true");
    prev();
    expect(counter()).toBe("Step 1 of 3");

    next();
    next();
    expect(counter()).toBe("Step 3 of 3");
    const nextButton = screen.getByRole("button", { name: /next/i }) as HTMLButtonElement;
    expect(nextButton.getAttribute("aria-disabled")).toBe("true");
    expect(nextButton.disabled).toBe(false);
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
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });
});
