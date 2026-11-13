import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    disputes: [],
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
        answer: { results: [{ stdout: "tokens: 1", exitCode: 0 }, { stdout: "4", exitCode: 0, stderr: "warning: x" }], files: [] },
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

  it("shows the review as a model's verdict, apart from the tests, and lets the learner dispute it or a case", async () => {
    const criterion = { passed: true, note: "Fine." };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "The tutor is busy." }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    show({
      ...view,
      spec: {
        ...view.spec,
        cases: [view.spec.cases[0], { ...view.spec.cases[1], withdrawn: true }],
        disputes: [{ id: "d1", target: "case", caseIndex: 1, caseName: "compiled", reason: "Not in the spec.", outcome: "withdrawn", explanation: "Agreed.", createdAt: "2026-11-13T11:30:00.000Z" }],
      },
      latestAttempt: {
        answer: { results: [{ stdout: "tokens: 1", exitCode: 0 }], files: ["main.py"], source: "git" },
        grade: { correct: true, passed: 1, total: 1, cases: [{ passed: true, case: 0 }] },
        createdAt: "2026-11-13T12:00:00.000Z",
      },
      latestReview: {
        review: { noHardCodedOutputs: { passed: false, note: "It prints canned answers." }, concept: criterion, quality: criterion, summary: "Compute the count.", suggestions: [], approved: false, judgedBy: "model", model: "m" },
        createdAt: "2026-11-13T12:00:01.000Z",
      },
      passed: false,
    });
    expect(screen.getByTestId("milestone-status").textContent).toContain("Not yet.");
    const review = screen.getByTestId("milestone-review");
    expect(review.dataset.approved).toBe("false");
    expect(review.textContent).toContain("Judged by a model");
    expect(review.textContent).toContain("It prints canned answers.");
    expect(screen.getByText(/Sent for review: main.py/)).toBeTruthy();
    expect(screen.getAllByTestId("milestone-case").map((c) => c.dataset.result)).toEqual(["passed", "withdrawn"]);
    expect(screen.getByTestId("milestone-disputes").textContent).toContain('Case "compiled": withdrawn');
    // A withdrawn case can't be disputed again.
    expect(screen.queryByRole("button", { name: "Dispute case: compiled" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dispute this verdict" }));
    fireEvent.change(screen.getByLabelText("Why is the verdict wrong?"), { target: { value: "It computes it." } });
    fireEvent.click(screen.getByRole("button", { name: "Send dispute" }));
    await waitFor(() => expect(screen.getByText("The tutor is busy.")).toBeTruthy());
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ target: "review", reason: "It computes it." });
    vi.unstubAllGlobals();
  });

  it("explains why there's no review yet", () => {
    show({
      ...view,
      latestAttempt: {
        answer: { results: [{ stdout: "x", exitCode: 0 }, { stdout: "3", exitCode: 0 }], files: [] },
        grade: { correct: false, passed: 1, total: 2, cases: [{ passed: false }, { passed: true }] },
        createdAt: "2026-11-13T11:00:00.000Z",
      },
      passed: false,
    });
    expect(screen.getByTestId("milestone-review-missing").textContent).toContain("once every case passes");
  });

  it("shows a placeholder for a view with private fields", () => {
    show({ ...view, spec: { ...view.spec, referenceSolution: "print(1)" } });
    expect(screen.getByRole("note").textContent).toContain("Can't display this item.");
  });
});
