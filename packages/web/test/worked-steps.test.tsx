import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { induction } from "./fixtures.js";

const renderSteps = (data: unknown = induction) => render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
const steps = () => screen.getAllByTestId("worked-step");
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));

describe("WorkedSteps", () => {
  it("reveals steps cumulatively, and hides them again going back", () => {
    renderSteps();
    expect(steps()).toHaveLength(1);
    expect(screen.queryByText("Inductive step")).toBeNull();
    next();
    expect(steps()).toHaveLength(2);
    expect(steps()[0]!.textContent).toContain("Base case");
    next();
    expect(steps()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /prev/i }));
    expect(steps()).toHaveLength(2);
  });

  it("show all reveals everything and keeps focus on the same button", () => {
    renderSteps();
    const button = screen.getByRole("button", { name: "Show all" });
    button.focus();
    fireEvent.click(button);
    expect(steps()).toHaveLength(3);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Start over");
    fireEvent.click(button);
    expect(steps()).toHaveLength(1);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Show all");
  });

  it("keeps focus on next at the last step", () => {
    renderSteps();
    const button = screen.getByRole("button", { name: /next/i }) as HTMLButtonElement;
    button.focus();
    next();
    next();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    next();
    expect(steps()).toHaveLength(3);
  });

  it("announces added steps and the position, and marks the current step", () => {
    const { container } = renderSteps();
    const list = container.querySelector("ol")!;
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-relevant")).toBe("additions");
    expect(screen.getByRole("status").textContent).toBe("Step 1 of 3");
    next();
    expect(screen.getByRole("status").textContent).toBe("Step 2 of 3");
    expect(steps()[0]!.getAttribute("aria-current")).toBeNull();
    expect(steps()[1]!.getAttribute("aria-current")).toBe("step");
  });

  it("renders formulas in the statement, justification, goal and title, and keeps the rest literal", () => {
    renderSteps();
    expect(steps()[0]!.textContent).toContain("2*3*4");
    expect(steps()[0]!.querySelector("em")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    const last = steps()[2]!;
    expect(last.querySelectorAll(".katex")).toHaveLength(2);
    // \displaystyle gives a large operator without display mode's own block.
    expect(last.querySelector(".katex-display")).toBeNull();
    expect(last.querySelector(".op-symbol.large-op")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 3 }).querySelector(".katex")).not.toBeNull();
    expect(screen.getByText(/^Goal/).parentElement!.querySelector(".katex")).not.toBeNull();
  });

  it("steps with the arrow keys", () => {
    renderSteps();
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowRight" });
    expect(steps()).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowLeft" });
    expect(steps()).toHaveLength(1);
  });

  it("has no controls for a single step", () => {
    renderSteps({ ...induction, spec: { title: "One", steps: [{ statement: "s", justification: "j" }] } });
    expect(screen.queryByRole("button")).toBeNull();
    expect(steps()).toHaveLength(1);
  });
});
