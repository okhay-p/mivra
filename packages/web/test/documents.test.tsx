import type { DocumentView } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachButton, DocumentChips, useDocuments } from "../src/Documents.js";

const doc = (over: Partial<DocumentView> = {}): DocumentView => ({
  id: "d1",
  sessionId: "s1",
  filename: "Week 3.pdf",
  kind: "pdf",
  byteSize: 100,
  pageCount: 12,
  pagesWithText: 12,
  status: "ready",
  createdAt: "2026-10-30T00:00:00.000Z",
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const file = (name = "notes.pdf", size = 10) => {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};

function Harness({ sessionId }: { sessionId: string }) {
  const documents = useDocuments(sessionId);
  return (
    <>
      <DocumentChips documents={documents} />
      <AttachButton documents={documents} />
    </>
  );
}
const choose = (f: File) => fireEvent.change(screen.getByTestId("document-input"), { target: { files: [f] } });

/** Answers each request by hand, in whatever order a test wants. */
function pendingFetch() {
  const calls: { url: string; method: string; respond: (r: Response) => void }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    return new Promise((resolve) => calls.push({ url, method, respond: resolve }));
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("documents near the composer", () => {
  it("shows chips with name and page count, as plain text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([doc(), doc({ id: "d2", kind: "pptx", filename: "<b>Deck $x$</b>.pptx", pageCount: 1, pagesWithText: 1 })]));
    render(<Harness sessionId="s1" />);
    expect(await screen.findByText("Week 3.pdf")).toBeTruthy();
    expect(screen.getByText("12 pages")).toBeTruthy();
    expect(screen.getByText("1 slide")).toBeTruthy();
    expect(screen.getByText("<b>Deck $x$</b>.pptx")).toBeTruthy();
    expect(screen.getByText(/images and diagrams aren't/)).toBeTruthy();
  });

  it("says when some pages had no text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([doc({ pagesWithText: 4 })]));
    render(<Harness sessionId="s1" />);
    expect(await screen.findByText("12 pages, 4 with text")).toBeTruthy();
  });

  it("shows nothing but the button with no documents", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([]));
    render(<Harness sessionId="s1" />);
    expect(await screen.findByRole("button", { name: /Attach/ })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("opens the hidden input from a real, keyboard-reachable button, for the right types", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([]));
    render(<Harness sessionId="s1" />);
    const input = screen.getByTestId("document-input") as HTMLInputElement;
    expect(input.accept).toBe(".pdf,.pptx");
    const click = vi.spyOn(input, "click");
    const button = screen.getByRole("button", { name: /Attach/ }) as HTMLButtonElement;
    expect(button.tabIndex).toBe(0);
    expect(button.type).toBe("button");
    fireEvent.click(button);
    expect(click).toHaveBeenCalled();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  });

  it("shows a busy state while uploading, then the new chip", async () => {
    const calls = pendingFetch();
    render(<Harness sessionId="s1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.respond(json([]));
    choose(file("new.pdf"));
    expect(await screen.findByText("Reading new.pdf…")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Attach/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(calls[1]!.url).toContain("/api/sessions/s1/documents");
    calls[1]!.respond(json(doc({ filename: "new.pdf" }), 201));
    expect(await screen.findByText("new.pdf")).toBeTruthy();
    expect(screen.queryByText("Reading new.pdf…")).toBeNull();
    expect((screen.getByRole("button", { name: /Attach/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["too big", 413, "This file is over the 25 MB limit."],
    ["wrong type", 415, "Only PDF and PowerPoint (.pptx) files can be attached."],
    ["scanned", 422, "This PDF has no readable text; it's probably scanned."],
    ["encrypted", 422, "This file is password-protected. Remove the password and upload it again."],
  ])("shows the server's message inline for %s", async (_name, status, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ error: message }, status));
    render(<Harness sessionId="s1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    choose(file());
    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("refuses an obviously oversized file without uploading it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([]));
    render(<Harness sessionId="s1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    choose(file("huge.pdf", 26 * 1024 * 1024));
    expect((await screen.findByRole("alert")).textContent).toContain("over the 25 MB limit");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("removes a chip, and keeps it with an error if that fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([doc()]))
      .mockResolvedValueOnce(json({ error: "Database is busy" }, 500))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<Harness sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Week 3.pdf" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Database is busy");
    expect(screen.getByText("Week 3.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Week 3.pdf" }));
    await waitFor(() => expect(screen.queryByText("Week 3.pdf")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the right list after switching sessions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([doc()])).mockResolvedValueOnce(json([doc({ id: "d2", sessionId: "s2", filename: "Other.pdf" })]));
    const { rerender } = render(<Harness sessionId="s1" />);
    expect(await screen.findByText("Week 3.pdf")).toBeTruthy();
    rerender(<Harness sessionId="s2" />);
    expect(await screen.findByText("Other.pdf")).toBeTruthy();
    expect(screen.queryByText("Week 3.pdf")).toBeNull();
  });

  it("ignores a list that arrives after the session changed", async () => {
    const calls = pendingFetch();
    const { rerender } = render(<Harness sessionId="s1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<Harness sessionId="s2" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.respond(json([doc({ id: "d2", sessionId: "s2", filename: "Mine.pdf" })]));
    expect(await screen.findByText("Mine.pdf")).toBeTruthy();
    calls[0]!.respond(json([doc({ filename: "Stale.pdf" })]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("Stale.pdf")).toBeNull();
  });

  it("shows an upload's chip if its session is showing again when it finishes", async () => {
    const calls = pendingFetch();
    const keyed = (sessionId: string) => <Harness key={sessionId} sessionId={sessionId} />;
    const { rerender } = render(keyed("s1"));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.respond(json([]));
    choose(file("a.pdf"));
    await waitFor(() => expect(calls).toHaveLength(2));
    // Away and back, as the app does: each session gets a new view.
    rerender(keyed("s2"));
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.respond(json([]));
    rerender(keyed("s1"));
    await waitFor(() => expect(calls).toHaveLength(4));
    calls[3]!.respond(json([]));

    calls[1]!.respond(json(doc({ filename: "a.pdf" }), 201));
    await waitFor(() => expect(calls).toHaveLength(5));
    expect(calls[4]).toMatchObject({ method: "GET" });
    expect(calls[4]!.url).toContain("/api/sessions/s1/documents");
    calls[4]!.respond(json([doc({ filename: "a.pdf" })]));
    expect(await screen.findByText("a.pdf")).toBeTruthy();
  });

  it("doesn't refresh another session's list when an upload finishes", async () => {
    const calls = pendingFetch();
    const keyed = (sessionId: string) => <Harness key={sessionId} sessionId={sessionId} />;
    const { rerender } = render(keyed("s1"));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.respond(json([]));
    choose(file("a.pdf"));
    await waitFor(() => expect(calls).toHaveLength(2));
    rerender(keyed("s2"));
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.respond(json([]));
    calls[1]!.respond(json(doc({ filename: "a.pdf" }), 201));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(3);
    expect(screen.queryByText("a.pdf")).toBeNull();
  });

  it("doesn't show a chip twice if the list already has the new document", async () => {
    const calls = pendingFetch();
    const { rerender } = render(<Harness sessionId="s1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.respond(json([]));
    choose(file("a.pdf"));
    await waitFor(() => expect(calls).toHaveLength(2));
    rerender(<Harness sessionId="s2" />);
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.respond(json([]));
    rerender(<Harness sessionId="s1" />);
    await waitFor(() => expect(calls).toHaveLength(4));
    calls[3]!.respond(json([doc({ filename: "a.pdf" })]));
    expect(await screen.findByText("a.pdf")).toBeTruthy();
    calls[1]!.respond(json(doc({ filename: "a.pdf" }), 201));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getAllByText("a.pdf")).toHaveLength(1);
  });

  it("ignores an upload that finishes or fails after the session changed", async () => {
    const calls = pendingFetch();
    const { rerender } = render(<Harness sessionId="s1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.respond(json([]));
    choose(file("a.pdf"));
    await waitFor(() => expect(calls).toHaveLength(2));
    rerender(<Harness sessionId="s2" />);
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.respond(json([]));
    expect(screen.queryByText("Reading a.pdf…")).toBeNull();
    expect((screen.getByRole("button", { name: /Attach/ }) as HTMLButtonElement).disabled).toBe(false);

    calls[1]!.respond(json({ error: "Stale failure" }, 422));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("a.pdf")).toBeNull();
  });
});
