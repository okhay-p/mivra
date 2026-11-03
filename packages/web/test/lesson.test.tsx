import type { LessonView } from "@mivra/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LessonPage, TopicList } from "../src/Lesson.js";
import { question } from "./fixtures.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const base: LessonView = {
  id: "l1",
  courseId: "c1",
  topicId: "t1",
  topicTitle: "Limits",
  position: 0,
  status: "generating",
  version: 1,
  outline: {
    title: "What a limit is",
    sections: [
      { title: "Intro", kind: "prose" },
      { title: "Check", kind: "multiple_choice" },
    ],
  },
  sections: [{ id: "s1", title: "Intro", kind: "prose", markdown: "A **limit** is where $f$ heads.", revisits: [] }],
  checks: { total: 0, answered: 0 },
  syllabusVersion: 1,
  changedSectionIds: [],
  changeReason: null,
  canFinish: false,
  error: null,
  createdAt: "2026-11-03T00:00:00.000Z",
  finishedAt: null,
};
const ready: LessonView = {
  ...base,
  status: "ready",
  sections: [...base.sections, { id: "s2", title: "Check", kind: "artifact", artifact: question }],
  checks: { total: 1, answered: 0 },
};

/** Serves lesson views in order; each long-poll after the last one never resolves, like a held request. */
function serve(views: LessonView[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/finish")) return json({ lesson: { ...ready, status: "finished", checks: { total: 1, answered: 1 } }, revision: "f" });
    const view = views[i++];
    if (!view) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    return json({ lesson: view, revision: `r${i}` });
  });
}

describe("LessonPage", () => {
  it("shows written sections and placeholders for the rest while generating, then the rest as it arrives", async () => {
    const fetch = serve([base, ready]);
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} />);
    expect(await screen.findByRole("heading", { name: "What a limit is" })).toBeTruthy();
    // Each later request waits for the next change after the revision it has.
    await screen.findByRole("region", { name: "Check" });
    expect(String(fetch.mock.calls[1]![0])).toContain("after=r1");
  });

  it("marks a section still being written", async () => {
    serve([base]);
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} />);
    expect(await screen.findByRole("region", { name: "Check (being written)" })).toBeTruthy();
    expect(screen.getByText("Writing…")).toBeTruthy();
  });

  it("can't be finished until every check is answered, then offers the next lesson", async () => {
    serve([ready]);
    const onFinished = vi.fn();
    const { rerender } = render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={onFinished} onStartNext={async () => {}} />);
    const finish = (await screen.findByRole("button", { name: "Finish lesson" })) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    expect(screen.getByText(/0 of 1 checks answered/)).toBeTruthy();
    expect(screen.getByText(/your score doesn't matter/)).toBeTruthy();
    cleanupFetch();
    serve([{ ...ready, checks: { total: 1, answered: 1 }, canFinish: true }]);
    rerender(<LessonPage key="again" lessonId="l1" nextTopic={undefined} onFinished={onFinished} onStartNext={async () => {}} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Finish lesson" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Finish lesson" })));
    expect(onFinished).toHaveBeenCalled();
    expect(await screen.findByText("Finished. This lesson won't change.")).toBeTruthy();
    // Not the end of the course while another lesson is still unfinished.
    expect(screen.queryByText("You've reached the end of the syllabus.")).toBeNull();
  });

  it("announces the end of the syllabus once the course is complete", async () => {
    serve([{ ...ready, status: "finished", checks: { total: 1, answered: 1 } }]);
    render(<LessonPage lessonId="l1" nextTopic={undefined} courseComplete onFinished={() => {}} onStartNext={async () => {}} />);
    expect(await screen.findByText("You've reached the end of the syllabus.")).toBeTruthy();
  });

  it("offers to carry on when generation stopped part-way", async () => {
    serve([{ ...base, status: "failed", error: "The lesson stopped before it was finished." }]);
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} />);
    expect(await screen.findByText("The lesson stopped before it was finished.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue writing" })).toBeTruthy();
  });
});

describe("LessonPage actions", () => {
  it("offers Explain and Change on each section of a lesson that can change", async () => {
    serve([ready]);
    const onExplain = vi.fn();
    const onChange = vi.fn();
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} onExplain={onExplain} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explain: Intro" }));
    expect(onExplain).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", title: "Intro" }));
    fireEvent.click(screen.getByRole("button", { name: "Change: Check" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
  });

  it("offers no Change on a finished lesson, only Explain", async () => {
    serve([{ ...ready, status: "finished", checks: { total: 1, answered: 1 } }]);
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} onExplain={() => {}} onChange={() => {}} />);
    expect(await screen.findByRole("button", { name: "Explain: Intro" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Change/ })).toBeNull();
  });

  it("highlights the sections a new version changed, with the reason", async () => {
    serve([{ ...ready, version: 2, changedSectionIds: ["s1"], changeReason: "Simpler intro" }]);
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} />);
    const intro = await screen.findByRole("region", { name: "Intro" });
    expect(intro.dataset.changed).toBe("true");
    expect(intro.textContent).toContain("Changed in v2");
    expect(screen.getByRole("region", { name: "Check" }).dataset.changed).toBeUndefined();
    expect(screen.getByText("Version 2: Simpler intro")).toBeTruthy();
  });
});

describe("links back", () => {
  it("links a revisiting section back to the earlier one", async () => {
    serve([{ ...ready, sections: [{ ...ready.sections[0]!, revisits: [{ lessonId: "l0", sectionId: "old", title: "The idea", lessonTitle: "Limits" }] } as LessonView["sections"][number], ready.sections[1]!] }]);
    const onOpenSection = vi.fn();
    render(<LessonPage lessonId="l1" nextTopic={undefined} onFinished={() => {}} onStartNext={async () => {}} onOpenSection={onOpenSection} />);
    fireEvent.click(await screen.findByRole("button", { name: "Limits: The idea" }));
    expect(onOpenSection).toHaveBeenCalledWith("l0", "old");
  });
});

describe("TopicList", () => {
  it("lists every topic, with only started ones selectable", () => {
    const onSelect = vi.fn();
    render(
      <TopicList
        lessons={{
          topics: [
            { topicId: "t1", title: "Limits", lesson: { id: "l1", status: "finished" } },
            { topicId: "t2", title: "Derivatives", lesson: null },
          ],
          currentLessonId: "l1",
          nextTopicId: "t2",
        }}
        selectedId="l1"
        onSelect={onSelect}
      />,
    );
    const [limits, derivatives] = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(limits!.textContent).toContain("(finished)");
    expect(limits!.getAttribute("aria-current")).toBe("page");
    expect(derivatives!.disabled).toBe(true);
    fireEvent.click(limits!);
    expect(onSelect).toHaveBeenCalledWith("l1");
  });
});

function cleanupFetch() {
  vi.restoreAllMocks();
}
