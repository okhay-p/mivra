import type { MemoryView } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "../src/MemoryPanel.js";

const memory = (over: Partial<MemoryView> = {}): MemoryView => ({
  id: "m1",
  kind: "goal",
  text: "Wants to pass interviews",
  concept: null,
  basis: "chat",
  createdAt: "2026-10-30T00:00:00.000Z",
  editedAt: null,
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const openPanel = (...responses: Response[]) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  render(<MemoryPanel open onOpenChange={() => {}} />);
  return fetch;
};
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

  it("says so when there is nothing yet, and shows load errors", async () => {
    openPanel(json([]));
    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });

  it("shows the server's error when loading fails", async () => {
    openPanel(json({ error: "Database is busy" }, 500));
    expect(await screen.findByText("Database is busy")).toBeTruthy();
  });

  it("saves an edit and shows the result", async () => {
    const fetch = openPanel(json([memory()]), json(memory({ text: "Wants a new job", editedAt: "2026-10-31T00:00:00.000Z" })));
    fireEvent.click(await button("Edit"));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory text" }), { target: { value: "Wants a new job" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Wants a new job")).toBeTruthy();
    expect(screen.getByText("Edited by you")).toBeTruthy();
    const [url, init] = fetch.mock.calls[1]!;
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
    expect((screen.getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement).value).toBe("Draft");
  });

  it("asks before deleting, and removes the entry once deleted", async () => {
    const fetch = openPanel(json([memory()]), new Response(null, { status: 204 }));
    fireEvent.click(await button("Delete"));
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(await button("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => expect(screen.queryByText("Wants to pass interviews")).toBeNull());
    expect(fetch.mock.calls[1]![1]?.method).toBe("DELETE");
  });
});
