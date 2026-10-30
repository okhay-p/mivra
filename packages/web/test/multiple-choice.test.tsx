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
  refreshed?: ArtifactView;
}) {
  const [view, setView] = useState<ArtifactView>();
  const onRefresh = async () => {
    if (refreshed) setView(refreshed);
  };
  return <ArtifactPart data={view ?? data} replyInProgress={replyInProgress} onUpdate={setView} onRefresh={onRefresh} />;
}

const option = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const options = () => screen.getAllByRole("button") as HTMLButtonElement[];
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("MultipleChoice", () => {
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

    expect(option(/^Never/).className).toContain("incorrect");
    expect(option(/^Never/).textContent).toContain("Your answer, incorrect");
    expect(option(/^When the sum/).className).toContain("correct");
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
