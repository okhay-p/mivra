import type { CourseSummaryView, MemoryView } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "../src/MemoryPanel.js";

const memory = (over: Partial<MemoryView> = {}): MemoryView => ({
  id: "m1",
  kind: "goal",
  held: false,
  text: "Wants to pass interviews",
  concept: null,
  basis: "chat",
  source: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  editedAt: null,
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const course = (over: Partial<CourseSummaryView> = {}): CourseSummaryView => ({
  id: "c1",
  sessionId: "s1",
  title: "Discrete Math: Induction",
  icon: "sigma",
  kind: "lessons",
  status: "complete",
  lessonsFinished: 3,
  topicCount: 3,
  completedAt: "2026-11-02T00:00:00.000Z",
  ...over,
});
const isCourses = (url: unknown) => /\/api\/courses$/.test(String(url instanceof Request ? url.url : url));
/**
 * Renders the panel open. GET /courses answers with `courses` every time; every other request, in order, with `responses`.
 * Returns the other requests, in order.
 */
const openPanelWith = (courses: CourseSummaryView[], responses: Response[], props: Partial<Parameters<typeof MemoryPanel>[0]> = {}) => {
  const queue = [...responses];
  const others: Parameters<typeof globalThis.fetch>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    if (isCourses(args[0])) return json(courses);
    others.push(args);
    return queue.shift() ?? json({ error: "Unexpected request" }, 500);
  });
  render(<MemoryPanel open onOpenChange={() => {}} onOpenCourse={() => {}} {...props} />);
  return others;
};
const openPanel = (...responses: Response[]) => openPanelWith([], responses);
const button = (name: string) => screen.findByRole("button", { name });

describe("MemoryPanel", () => {
  it("shows memories by kind and what supports them", async () => {
    openPanel(json([memory(), memory({ id: "m2", kind: "misconception", text: "Thinks windows always shrink", basis: "wrong_answer" })]));
    expect(await screen.findByText("Goals")).toBeTruthy();
    expect(screen.getByText("Misconceptions")).toBeTruthy();
    expect(screen.queryByText("Preferences")).toBeNull();
    expect(screen.getByText("From a wrong answer")).toBeTruthy();
    expect(screen.getByText("From chat")).toBeTruthy();
  });

  it("says so when there is nothing yet", async () => {
    openPanel(json([]));
    expect(await screen.findByText("No memories yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Courses" })).toBeNull();
  });

  it("lists courses that are setting up, in progress and complete, each with a way to open it", async () => {
    const onOpenCourse = vi.fn();
    const onOpenChange = vi.fn();
    openPanelWith(
      [
        course({ id: "c3", sessionId: "s3", title: "Learn Rust", icon: null, status: "interviewing", lessonsFinished: 0, topicCount: 0, completedAt: null }),
        course({ id: "c2", sessionId: "s2", title: "A word counter", icon: "terminal", kind: "project", status: "active", lessonsFinished: 1, topicCount: 4, completedAt: null }),
        course(),
      ],
      [json([memory()])],
      { onOpenCourse, onOpenChange },
    );
    const section = await screen.findByRole("region", { name: "Courses" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Learn RustSetting up"),
      expect.stringContaining("A word counterIn progress1 of 4 milestones finished"),
      expect.stringContaining("Discrete Math: InductionComplete3 of 3 lessons finished"),
    ]);
    expect(items[0]!.textContent).not.toContain("finished");
    expect(items[2]!.textContent).toContain(new Date("2026-11-02T00:00:00.000Z").toLocaleDateString());
    expect(screen.getByText("Wants to pass interviews")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Continue setting up Learn Rust" }));
    expect(onOpenCourse).toHaveBeenLastCalledWith("s3");
    fireEvent.click(within(section).getByRole("button", { name: "Open Discrete Math: Induction" }));
    expect(onOpenCourse).toHaveBeenLastCalledWith("s1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows courses with a short note when there are no memories yet", async () => {
    openPanelWith([course()], [json([])]);
    expect(await screen.findByRole("region", { name: "Courses" })).toBeTruthy();
    expect(screen.getByText(/^No memories yet\. As you learn/)).toBeTruthy();
    // The big empty state is only for a learner with neither.
    expect(screen.queryByText("Back to learning")).toBeNull();
  });

  it("shows the server's error when loading fails", async () => {
    openPanel(json({ error: "Database is busy" }, 500));
    expect(await screen.findByText("Database is busy")).toBeTruthy();
  });

  it("hides a held memory's content, and allows deleting but not editing it", async () => {
    openPanel(json([memory({ held: true, text: null, basis: null })]));
    expect(await screen.findByText("Hidden until you answer the check in that session.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByText("From chat")).toBeNull();
  });

  it("refreshes when the window regains focus, so a released memory appears", async () => {
    openPanel(json([memory({ held: true, text: null, basis: null })]), json([memory()]));
    await screen.findByText("Hidden until you answer the check in that session.");
    fireEvent.focus(window);
    expect(await screen.findByText("Wants to pass interviews")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement).value).toBe("Wants to pass interviews");
  });

  it("saves an edit and shows the result", async () => {
    const calls = openPanel(json([memory()]), json(memory({ text: "Wants a new job", editedAt: "2026-10-31T00:00:00.000Z" })));
    fireEvent.click(await button("Edit"));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory text" }), { target: { value: "Wants a new job" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Wants a new job")).toBeTruthy();
    expect(screen.getByText("Edited by you")).toBeTruthy();
    const [url, init] = calls[1]!;
    expect(String(url)).toMatch(/\/api\/memories\/m1$/);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Wants a new job" });
  });

  it("keeps the draft and shows the error if saving fails", async () => {
    openPanel(json([memory()]), json({ error: "Memory not found" }, 404));
    fireEvent.click(await button("Edit"));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory text" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Memory not found")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Memory text" });
    expect((input as HTMLTextAreaElement).value).toBe("Draft");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toContain("Memory not found");
  });

  it("asks before deleting, and removes the entry once deleted", async () => {
    const calls = openPanel(json([memory()]), new Response(null, { status: 204 }));
    fireEvent.click(await button("Delete"));
    expect(calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(await button("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => expect(screen.queryByText("Wants to pass interviews")).toBeNull());
    expect(calls[1]![1]?.method).toBe("DELETE");
  });

  it("shows memories drawn from notes with their note, filters them, and deletes them all at once", async () => {
    const source = { noteId: "n1", importId: "i1", importName: "Vault", path: "CS/Recursion.md", title: "Recursion" };
    const calls = openPanel(
      json([memory(), memory({ id: "k1", kind: "known", text: "Has notes on recursion.", concept: "Recursion", basis: "import", source })]),
      json({ deleted: 1 }),
    );
    expect(await screen.findByText("Known from your notes")).toBeTruthy();
    expect(screen.getByText("From your note Recursion")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "From notes" }));
    expect(screen.queryByText("Wants to pass interviews")).toBeNull();
    expect(screen.getByText("Has notes on recursion.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "From learning" }));
    expect(screen.queryByText("Has notes on recursion.")).toBeNull();
    expect(screen.getByText("Wants to pass interviews")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "From notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all from notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete all" }));
    await waitFor(() => expect(screen.queryByText("Has notes on recursion.")).toBeNull());
    expect(screen.getByText("Wants to pass interviews")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "From notes" })).toBeNull();
    const [url, init] = calls[1]!;
    expect(String(url)).toMatch(/\/api\/memories\?basis=import$/);
    expect(init?.method).toBe("DELETE");
  });
});

describe("Export to Obsidian", () => {
  it("downloads the zip with the API token and names it as the server says", async () => {
    const createObjectURL = vi.fn(() => "blob:export");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const zip = new Response(new Uint8Array([0x50, 0x4b]), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="Mivra-2026-11-10.zip"' } });
    const calls = openPanel(json([memory()]), zip);
    fireEvent.click(await button("Export to Obsidian"));
    expect(await screen.findByText(/^Downloaded Mivra-2026-11-10\.zip\./)).toBeTruthy();
    const [url, init] = calls[1]!;
    expect(String(url)).toMatch(/\/api\/export\/obsidian$/);
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer\b/);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it("shows the server's error", async () => {
    openPanel(json([memory()]), json({ error: "There's too much to export as one zip." }, 413));
    fireEvent.click(await button("Export to Obsidian"));
    expect(await screen.findByText("There's too much to export as one zip.")).toBeTruthy();
  });
});
