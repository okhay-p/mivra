import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { MilestoneCourseContext } from "../src/artifacts/ProjectMilestone.js";

const view = {
  id: "a1",
  createdAt: "2026-11-13T10:00:00.000Z",
  kind: "project_milestone",
  version: 1,
  spec: {
    concept: "tokenizing",
    title: "Count the tokens",
    spec: "Print how many tokens the input has.",
    outputFormat: "One line: `tokens: N`.",
    checkType: "tests",
    cases: [
      { name: "one number", input: "42", compare: "stdout", expected: "tokens: 1" },
      { name: "compiled", input: "1 + 2", compare: "run_output", expected: "3" },
    ],
  },
};

const show = (data: unknown) =>
  render(
    <MilestoneCourseContext.Provider value="course-1">
      <ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />
    </MilestoneCourseContext.Provider>,
  );

describe("ProjectMilestone", () => {
  it("shows what to build, the cases and how to check them from a repository", () => {
    show(view);
    const card = screen.getByRole("region", { name: "Count the tokens" });
    expect(within(card).getByText("Print how many tokens the input has.")).toBeTruthy();
    expect(card.textContent).toContain('mivra link course-1 --run "./your-program {input}" --run-output "./run-it {output}"');
    expect(card.textContent).toContain("mivra check");
    expect(card.textContent).toContain("Not checked yet.");
    expect(screen.getAllByTestId("milestone-case").map((c) => c.dataset.result)).toEqual(["pending", "pending"]);
    expect(card.textContent).toContain("runs your output");
  });

  it("shows the latest check: what passed, and what a failing case printed", () => {
    show({
      ...view,
      latestAttempt: {
        answer: { results: [{ stdout: "tokens: 1", exitCode: 0 }, { stdout: "4", exitCode: 0, stderr: "warning: x" }] },
        grade: { correct: false, passed: 1, total: 2, cases: [{ passed: true }, { passed: false }] },
        createdAt: "2026-11-13T11:00:00.000Z",
      },
    });
    expect(screen.getByTestId("milestone-status").textContent).toContain("Latest check: 1 of 2 cases passed");
    expect(screen.getAllByTestId("milestone-case").map((c) => c.dataset.result)).toEqual(["passed", "failed"]);
    const failed = screen.getAllByTestId("milestone-case")[1]!;
    expect(failed.textContent).toContain("Your program printed4");
    expect(failed.textContent).toContain("warning: x");
  });

  it("shows a placeholder for a view with private fields", () => {
    show({ ...view, spec: { ...view.spec, referenceSolution: "print(1)" } });
    expect(screen.getByRole("note").textContent).toContain("Can't display this item.");
  });
});
