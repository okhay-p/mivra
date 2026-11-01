import type { ArtifactView } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { answered, question } from "./fixtures.js";

/** Holds the updated view the way the chat does, so a graded answer re-renders. */
function Harness({
  data,
  replyInProgress = false,
  refreshed,
}: {
  data: unknown;
  replyInProgress?: boolean;
  /** What the chat's refresh would load from the server. */
  refreshed?: ArtifactView | Promise<never> | Error;
}) {
  const [view, setView] = useState<ArtifactView>();
  const onRefresh = async () => {
    if (refreshed instanceof Error) throw refreshed;
    const next = await refreshed;
    if (next) setView(next);
  };
  return <ArtifactPart data={view ?? data} replyInProgress={replyInProgress} onUpdate={setView} onRefresh={onRefresh} />;
}

const option = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const options = () => screen.getAllByRole("button") as HTMLButtonElement[];
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("MultipleChoice", () => {
  it("keeps answers that markdown would make identical distinct and literal", () => {
    render(<Harness data={{ ...question, spec: { ...question.spec, question: "Which is *it*, $x^2$?", options: [{ text: "2*3*4" }, { text: "234" }, { text: "$2*3*4$" }] } }} />);
    const [starred, plain, formula] = options();
    expect(starred!.textContent).toBe("2*3*4");
    expect(plain!.textContent).toBe("234");
    expect(starred!.querySelector("em, strong")).toBeNull();
    expect(formula!.querySelector("annotation")?.textContent).toBe("2*3*4");
    const title = screen.getByRole("region").querySelector('[data-slot="card-title"]')!;
    expect(title.querySelector("em")).toBeNull();
    expect(title.textContent).toContain("Which is *it*,");
    expect(title.querySelector("annotation")?.textContent).toBe("x^2");
  });

  it("posts the chosen option and shows the graded result", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(answered, 201));
    render(<Harness data={question} />);

    fireEvent.click(option(/^Never/));

    await screen.findByText("Not quite.");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/artifacts\/art-mc\/attempts$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ answer: { optionIndex: 0 } });

    expect(option(/^Never/).dataset.result).toBe("incorrect");
    expect(option(/^Never/).textContent).toContain("Your answer, incorrect");
    expect(option(/^When the sum/).dataset.result).toBe("correct");
    expect(option(/^When the sum/).textContent).toContain("Correct answer");
    expect(screen.getByText("Shrink to restore the invariant.")).toBeTruthy();
    expect(screen.getByText("It has to shrink at some point.")).toBeTruthy();
    expect(options().every((b) => b.disabled)).toBe(true);
  });

  it("shows the server's error inline and lets the learner retry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "The reply is still in progress; answer once it finishes" }, 409),
    );
    render(<Harness data={question} />);

    fireEvent.click(option(/^Every step/));

    await screen.findByText("The reply is still in progress; answer once it finishes");
    await waitFor(() => expect(options().every((b) => !b.disabled)).toBe(true));
  });

  it("shows the saved grade when the answer was recorded but its response was lost", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "This check has already been answered" }, 409));
    render(<Harness data={question} refreshed={answered} />);

    fireEvent.click(option(/^Never/));

    await screen.findByText("Not quite.");
    expect(options().every((b) => b.disabled)).toBe(true);
  });

  it("keeps answering disabled until the refresh after a failed answer finishes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "Can't save" }, 500));
    render(<Harness data={question} refreshed={new Promise<never>(() => {})} />);

    fireEvent.click(option(/^Never/));

    await screen.findByText("Can't save");
    expect(options().every((b) => b.disabled)).toBe(true);
  });

  it("re-enables answering when the refresh after a failed answer fails too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "Can't save" }, 500));
    render(<Harness data={question} refreshed={new Error("offline")} />);

    fireEvent.click(option(/^Never/));

    await screen.findByText("Can't save");
    await waitFor(() => expect(options().every((b) => !b.disabled)).toBe(true));
  });

  it("shows an existing attempt as graded and disables answering", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<Harness data={answered} />);

    expect(screen.getByText("Not quite.")).toBeTruthy();
    expect(option(/^Never/).textContent).toContain("Your answer, incorrect");
    expect(options().every((b) => b.disabled)).toBe(true);
    fireEvent.click(option(/^Every step/));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("disables answering while its reply is streaming", () => {
    render(<Harness data={question} replyInProgress />);

    expect(options().every((b) => b.disabled)).toBe(true);
    expect(screen.getByText("Answer once the reply finishes.")).toBeTruthy();
  });
});

describe("ArtifactPart", () => {
  it("shows a placeholder for data that isn't a valid artifact view", () => {
    // A check that leaks its answer key is not a valid view, so it must not render.
    const leaky = { ...question, spec: { ...question.spec, correctOptionIndex: 1 } };
    const { rerender } = render(<ArtifactPart data={leaky} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
    expect(screen.getByText("Can't display this item.")).toBeTruthy();
    expect(screen.queryByText(question.spec.question)).toBeNull();

    rerender(<ArtifactPart data={{ kind: "mystery" }} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
    expect(screen.getByText("Can't display this item.")).toBeTruthy();
  });
});
