import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { trace, walkthrough } from "./fixtures.js";

const renderPart = (data: ComponentProps<typeof ArtifactPart>["data"] = walkthrough) =>
  render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));
const prev = () => fireEvent.click(screen.getByRole("button", { name: /prev/i }));
const activeLines = () => screen.getAllByTestId("code-line").flatMap((line, i) => (line.dataset.active ? [i + 1] : []));
const variables = () => screen.queryAllByTestId("walkthrough-variable").map((v) => v.textContent);
const output = () => screen.getByTestId("walkthrough-output").textContent;
const status = () => screen.getByTestId("walkthrough-status").textContent;

/** Everything a step shows, to compare snapshots. */
const snapshot = () => ({ lines: activeLines(), variables: variables(), output: output(), status: status(), counter: screen.getByTestId("step-counter").textContent });

describe("CodeWalkthrough", () => {
  it("starts at step 1 and keeps code, variables, output and explanation in step together", () => {
    renderPart();
    expect(screen.getByText("Illustrated walkthrough")).toBeTruthy();
    expect(screen.getByTestId("step-counter").textContent).toBe("Step 1 of 4");
    expect(activeLines()).toEqual([2, 3]);
    expect(variables()).toEqual(["render.count= 0"]);
    expect(output()).toContain("Count: 0");
    expect(screen.getByTestId("walkthrough-label").textContent).toContain("Initial render");
    expect(status()).toContain("count starts at 0.");

    next();
    expect(screen.getByTestId("step-counter").textContent).toBe("Step 2 of 4");
    expect(activeLines()).toEqual([3]);
    expect(variables()).toEqual(["handler.count= 0", "queued update= count + 1"]);
    expect(screen.getByTestId("walkthrough-label").textContent).toContain("Click handler");
    expect(status()).toContain("The handler still sees 0 and queues 1.");
  });

  it("clears everything at a step with no lines, variables or output, and Prev restores the earlier snapshot exactly", () => {
    renderPart();
    next();
    const before = snapshot();
    next();
    expect(activeLines()).toEqual([]);
    expect(variables()).toEqual([]);
    expect(screen.getByText("No variables at this step")).toBeTruthy();
    expect(screen.getByText("No output yet")).toBeTruthy();
    expect(screen.queryByTestId("output-text")).toBeNull();
    expect(screen.queryByTestId("walkthrough-label")).toBeNull();
    expect(output()).not.toContain("Count: 0");
    prev();
    expect(snapshot()).toEqual(before);
  });

  it("shows source, variables and output as inert literal text, keeping whitespace", () => {
    const tricky = {
      ...walkthrough,
      spec: {
        title: "Literal text",
        code: { language: "HTML", source: '<script>alert("x")</script>\nconst price = "$5 and $10";' },
        steps: [
          {
            explanation: "Prints a tag.",
            lines: [1],
            variables: [{ name: "html", value: "<b>bold</b> $x$" }],
            output: "  <img src=x onerror=alert(1)>\n\n$5 **not bold**",
          },
        ],
      },
    };
    const { container } = renderPart(tricky);
    expect(container.querySelector("script, img, b, strong, .katex")).toBeNull();
    expect(screen.getAllByTestId("code-line")[1]!.textContent).toContain('const price = "$5 and $10";');
    expect(variables()).toEqual(["html= <b>bold</b> $x$"]);
    expect(screen.getByTestId("output-text").textContent).toBe("  <img src=x onerror=alert(1)>\n\n$5 **not bold**");
  });

  it("has no step controls for a single step", () => {
    renderPart({ ...walkthrough, spec: { ...walkthrough.spec, steps: [walkthrough.spec.steps[0]!] } });
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
    expect(screen.queryByTestId("step-counter")).toBeNull();
    expect(output()).toContain("Count: 0");
  });

  it("steps with the shared arrow keys and Play, announcing the step without reading the whole code", () => {
    renderPart();
    const card = screen.getByRole("region", { name: /A click on Counter/ });
    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(screen.getByTestId("step-counter").textContent).toBe("Step 2 of 4");
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    expect(screen.getByTestId("step-counter").textContent).toBe("Step 1 of 4");
    expect(within(card).getByRole("button", { name: "Play" })).toBeTruthy();

    const live = screen.getByTestId("walkthrough-status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(status()).toContain("Step 1 of 4.");
    expect(status()).toContain("Code line 2: const [count, setCount] = useState(0);");
    expect(status()).toContain("render.count = 0.");
    expect(status()).toContain("Output: Count: 0");
    expect(status()).not.toContain("function Counter()");
  });

  it("summarises long output in the announcement rather than reading all of it", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i} of a long printout`).join("\n");
    renderPart({ ...walkthrough, spec: { ...walkthrough.spec, steps: [{ explanation: "Prints a lot.", variables: [], output: long }] } });
    expect(status()).toContain("Output: 30 lines, in the output pane.");
    expect(status()).not.toContain("line 29");
    expect(screen.getByTestId("output-text").textContent).toBe(long);
  });

  it("leaves algorithm traces as they were", () => {
    renderPart(trace);
    expect(screen.getByText("Algorithm trace")).toBeTruthy();
    expect(screen.queryByTestId("walkthrough-status")).toBeNull();
  });
});
