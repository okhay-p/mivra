import type { ArtifactView, CourseView } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { CourseBar, StartCourseForm } from "../src/Course.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const placement = {
  id: "art-placement",
  createdAt: "2026-11-03T00:00:00.000Z",
  kind: "placement_question",
  version: 1,
  spec: { concept: "derivative", question: "Is the derivative of $x^2$ equal to $2x$?", options: [{ text: "Yes" }, { text: "No" }] },
} satisfies ArtifactView;

const graded = (answer: object, result: string): ArtifactView =>
  ({ ...placement, latestAttempt: { answer, grade: { result, correctOptionIndex: 0, explanation: "Power rule." }, createdAt: placement.createdAt } }) as ArtifactView;

function Harness({ data }: { data: unknown }) {
  const [view, setView] = useState<ArtifactView>();
  return <ArtifactPart data={view ?? data} replyInProgress={false} onUpdate={setView} onRefresh={async () => {}} />;
}

describe("PlacementQuestion", () => {
  it("always offers Not sure and Skip, and no confidence rating", () => {
    render(<Harness data={placement} />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Yes", "No", "Not sure", "Skip"]);
    expect(screen.queryByText(/confiden/i)).toBeNull();
  });

  it.each([
    ["Yes", { optionIndex: 0 }, "correct", "Correct."],
    ["Not sure", { unsure: true }, "unsure", "Marked as not sure."],
    ["Skip", { skipped: true }, "skipped", "Skipped."],
  ])("posts %s and shows the result", async (label, answer, result, summary) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(graded(answer, result), 201));
    render(<Harness data={placement} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText(summary);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ answer });
    expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    if (result === "skipped") expect(screen.queryByText("Power rule.")).toBeNull();
    else expect(screen.getByText("Power rule.")).toBeTruthy();
  });

  it("marks a wrong choice and the right one", () => {
    render(<Harness data={graded({ optionIndex: 1 }, "incorrect")} />);
    expect(screen.getByRole("button", { name: "No" }).dataset.result).toBe("incorrect");
    expect(screen.getByRole("button", { name: "Yes" }).dataset.result).toBe("correct");
    expect(screen.getByText("Not quite.")).toBeTruthy();
  });
});

const context = {
  id: "art-context",
  createdAt: "2026-11-03T00:00:00.000Z",
  kind: "interview_context",
  version: 1,
  spec: { question: "Anything else you'd like us to know?" },
} satisfies ArtifactView;

const contextAnswered = (answer: object, result: string): ArtifactView =>
  ({ ...context, latestAttempt: { answer, grade: { result }, createdAt: context.createdAt } }) as ArtifactView;

describe("InterviewContext", () => {
  it("is a clearly optional multiline field that can't be sent blank", () => {
    render(<Harness data={context} />);
    const field = screen.getByLabelText("Anything else you'd like us to know?");
    expect(field.tagName).toBe("TEXTAREA");
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.getByText(/Fine to leave blank/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the learner's words and shows them", async () => {
    const words = "I know the basics,\nbut want to dive into backprop.";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(contextAnswered({ text: words }, "answered"), 201));
    render(<Harness data={context} />);
    fireEvent.change(screen.getByLabelText("Anything else you'd like us to know?"), { target: { value: `  ${words} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ answer: { text: words } });
    expect(screen.getByText(/dive into backprop/)).toBeTruthy();
  });

  it("can be skipped", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(contextAnswered({ skipped: true }, "skipped"), 201));
    render(<Harness data={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("Skipped.");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ answer: { skipped: true } });
  });
});

describe("StartCourseForm", () => {
  const pickerView = {
    current: { model: "chatgpt:gpt-6.1-sol", effort: null },
    recent: [],
    pinned: [],
    suggested: [],
    models: [{ id: "chatgpt:gpt-6.1-sol", name: "GPT-6.1-Sol", contextLength: null, price: null, reasoning: null }],
    catalog: "fresh",
    providers: [],
    unavailable: null,
  };
  /** Answers the model picker's request, and `course` for everything else. */
  const serve = (course: Response) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (String(input).includes("/api/models") ? json(pickerView) : course));

  it("asks what to learn, offers the model choice, and starts a course with the goal", async () => {
    const session = { id: "s1", title: "Calculus", updatedAt: placement.createdAt, courseId: "c1" };
    const fetch = serve(
      json({ course: { id: "c1", sessionId: "s1", goal: "Calculus", status: "interviewing", syllabus: null, interviewMessageId: null, createdAt: placement.createdAt }, session }, 201),
    );
    const onStarted = vi.fn();
    render(<StartCourseForm onStarted={onStarted} onFreeChat={() => {}} />);
    expect(screen.getByRole("heading", { name: "What do you want to learn?" })).toBeTruthy();
    // The course is planned and taught by the model chosen here (it's the app-wide selection).
    expect(await screen.findByRole("button", { name: "Model: GPT-6.1-Sol (ChatGPT). Change model" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Learning goal" }), { target: { value: "  Calculus " } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ session, goal: "Calculus" }));
    const start = fetch.mock.calls.find(([url]) => /\/api\/courses$/.test(String(url)))!;
    expect(JSON.parse(String(start[1]?.body))).toEqual({ goal: "Calculus" });
  });

  it("shows the server's error", async () => {
    serve(json({ error: "Invalid goal" }, 400));
    render(<StartCourseForm onStarted={() => {}} onFreeChat={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Learning goal" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Invalid goal");
  });
});

describe("CourseBar", () => {
  const course: CourseView = {
    id: "c1",
    sessionId: "s1",
    goal: "Calculus",
    status: "active",
    interviewMessageId: null,
    createdAt: placement.createdAt,
    syllabus: {
      version: 1,
      source: "interview",
      reason: null,
      changedTopicIds: [],
      canUndo: false,
      createdAt: placement.createdAt,
      topics: [
        { id: "t1", title: "Limits", summary: "What a limit is.", reason: "You weren't sure.", requestedByLearner: false, concepts: ["limit"] },
        { id: "t2", title: "Chain rule", summary: "Compositions.", reason: "You asked.", requestedByLearner: true, concepts: ["chain rule"] },
      ],
      known: [{ concept: "derivative", source: "test", note: "Answered correctly." }],
    },
  };

  it("shows the interview status before a syllabus exists", () => {
    render(<CourseBar course={{ ...course, status: "interviewing", syllabus: null }} />);
    expect(screen.getByText("Placement interview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Syllabus/ })).toBeNull();
  });

  it("shows Mivra's automatic change with its reason, and undoes it", async () => {
    const onUndo = vi.fn(async () => undefined);
    render(<CourseBar course={{ ...course, syllabus: { ...course.syllabus!, version: 2, source: "adaptive", reason: "Added a refresher", canUndo: true, changedTopicIds: ["t2"] } }} onUndo={onUndo} />);
    expect(screen.getByText("Mivra changed the plan: Added a refresher")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onUndo).toHaveBeenCalled());
  });

  it("shows the syllabus with reasons and labelled knowledge", () => {
    render(<CourseBar course={course} />);
    fireEvent.click(screen.getByRole("button", { name: /Syllabus · 2 topics/ }));
    const topics = screen.getByRole("list", { name: "Syllabus topics" });
    expect(topics.textContent).toContain("Limits");
    expect(topics.textContent).toContain("Why: You weren't sure.");
    expect(topics.textContent).toContain("You asked for this");
    expect(screen.getByRole("list", { name: "What Mivra thinks you know" }).textContent).toContain("From the test");
  });
});
