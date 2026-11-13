import { aliasingComposition, eventLoopComposition, twoStackQueueComposition } from "@mivra/protocol/test/composition-fixtures";
import type { CompositionSpec } from "@mivra/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { MOVE_MS } from "../src/artifacts/composition-stage.js";

/**
 * jsdom has no layout, so these tests give it one: each card sits in its group's column, one row per place in
 * its list, and a card mid-glide is drawn part of the way along. That's enough to check what the motion layer
 * asks the browser to animate, and that it never changes what step is shown.
 */
interface FakeAnimation {
  el: HTMLElement;
  from: { x: number; y: number };
  options: KeyframeAnimationOptions;
  progress: number;
  cancelled: boolean;
  cancel: () => void;
  finish: () => void;
  finished: Promise<unknown>;
}

let animations: FakeAnimation[] = [];
let resizeCallbacks: (() => void)[] = [];
let gridWidth = 700;
const running = new Map<HTMLElement, FakeAnimation>();

const layoutOf = (el: HTMLElement) => {
  const grid = el.closest('[data-testid="composition-groups"]')!;
  const groups = [...grid.querySelectorAll("[data-group]")];
  const group = el.closest("[data-group]")!;
  const place = [...group.querySelectorAll('[data-testid="composition-entity"]')].indexOf(el);
  return { x: groups.indexOf(group) * 300, y: 100 + place * 80 };
};

beforeEach(() => {
  animations = [];
  resizeCallbacks = [];
  gridWidth = 700;
  running.clear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    if (!el.dataset?.entity) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    const { x, y } = layoutOf(el);
    const glide = running.get(el);
    const left = glide ? glide.from.x * (1 - glide.progress) : 0;
    const top = glide ? glide.from.y * (1 - glide.progress) : 0;
    return DOMRect.fromRect({ x: x + left, y: y + top, width: 200, height: 60 });
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "composition-groups" ? gridWidth : 0;
  });
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(keyframes[0]!.transform))!;
      let settle!: (value: unknown) => void;
      let fail!: (error: unknown) => void;
      const finished = new Promise((resolve, reject) => ((settle = resolve), (fail = reject)));
      const animation: FakeAnimation = {
        el: this,
        from: { x: Number(x), y: Number(y) },
        options,
        progress: 0,
        cancelled: false,
        finished,
        cancel: () => {
          if (running.get(this) === animation) running.delete(this);
          if (!animation.cancelled) fail(new DOMException("cancelled", "AbortError"));
          animation.cancelled = true;
        },
        finish: () => {
          running.delete(this);
          settle(animation);
        },
      };
      running.set(this, animation);
      animations.push(animation);
      return animation;
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const show = (spec: CompositionSpec) =>
  render(
    <ArtifactPart data={{ id: "art-composition", createdAt: "2026-11-13T00:00:00.000Z", kind: "composition", version: 1, spec }} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />,
  );
const card = () => screen.getByTestId("composition");
const grid = () => screen.getByTestId("composition-groups");
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const prev = () => fireEvent.click(screen.getByRole("button", { name: "Prev" }));
const seek = (to: number) => fireEvent.change(screen.getByTestId("composition-seek"), { target: { value: String(to) } });
const ids = (group: string) => [...grid().querySelectorAll<HTMLElement>(`[data-group="${group}"] [data-entity]`)].map((el) => el.dataset.entity);
const live = () => animations.filter((animation) => !animation.cancelled && running.get(animation.el) === animation);
/** What each group shows, which must be the same however the learner got to the step. */
const shown = () => [...grid().querySelectorAll<HTMLElement>("[data-group]")].map((group) => [group.dataset.group, group.textContent]);
const finishAll = async () => {
  await act(async () => {
    for (const animation of live()) animation.finish();
    await Promise.resolve();
  });
};

describe("Composition motion", () => {
  it("glides a reorder and a move between adjacent steps, from where each card was to where it is now", async () => {
    show(eventLoopComposition);
    next();
    // The step changes at once: motion only follows it.
    expect(ids("queue")).toEqual(["click", "timer", "fetch"]);
    expect(live().map((a) => [a.el.dataset.entity, a.from])).toEqual([
      ["click", { x: 0, y: 80 }],
      ["timer", { x: 0, y: -80 }],
    ]);
    expect(live()[0]!.options.duration).toBe(MOVE_MS);
    expect(grid().dataset.moving).toBe("true");
    await finishAll();
    expect(grid().dataset.moving).toBeUndefined();

    next();
    // onClick crosses from the queue's front to the stack; the two left behind move up a place.
    expect(ids("stack")).toEqual(["click"]);
    expect(Object.fromEntries(live().map((a) => [a.el.dataset.entity, a.from]))).toEqual({
      click: { x: -300, y: 0 },
      timer: { x: 0, y: 80 },
      fetch: { x: 0, y: 80 },
    });
    await finishAll();

    // Leaving is immediate: there's nothing to glide.
    next();
    expect(ids("stack")).toEqual([]);
    expect(live()).toEqual([]);
  });

  it("moves several cards at once, in either direction", async () => {
    show(twoStackQueueComposition);
    next();
    expect(ids("outbox")).toEqual(["one", "two", "three"]);
    expect(Object.fromEntries(live().map((a) => [a.el.dataset.entity, a.from]))).toEqual({
      one: { x: -300, y: 160 },
      two: { x: -300, y: 0 },
      three: { x: -300, y: -160 },
    });
    await finishAll();
    prev();
    expect(ids("inbox")).toEqual(["three", "two", "one"]);
    expect(live()).toHaveLength(3);
  });

  it("cuts on a seek, Restart, Home and End, even to the next step", () => {
    show(eventLoopComposition);
    seek(1);
    expect(ids("queue")).toEqual(["click", "timer", "fetch"]);
    seek(2);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.keyDown(card(), { key: "End" });
    fireEvent.keyDown(card(), { key: "Home" });
    expect(animations).toEqual([]);
    expect(ids("queue")).toEqual(["timer", "click", "fetch"]);
    // The arrow keys are steps, so they glide.
    fireEvent.keyDown(card(), { key: "ArrowRight" });
    expect(live().length).toBeGreaterThan(0);
  });

  it("cuts when the learner prefers reduced motion, with the same summary", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: query.includes("reduce") }) });
    show(eventLoopComposition);
    next();
    next();
    expect(animations).toEqual([]);
    expect(ids("stack")).toEqual(["click"]);
    expect(screen.getByTestId("composition-changes").textContent).toContain("onClick moves from Task queue to Call stack.");
    expect(screen.getByTestId("composition-status").textContent).toContain("onClick moves from Task queue to Call stack.");
  });

  it("rebases an interrupted glide from where the card is drawn, and always ends on the chosen step", async () => {
    const { unmount } = show(eventLoopComposition);
    seek(3);
    seek(2);
    const direct = shown();
    unmount();

    show(eventLoopComposition);
    seek(1);
    next(); // onClick: queue front → stack
    const first = live().find((a) => a.el.dataset.entity === "click")!;
    first.progress = 0.5; // Halfway across.
    prev(); // Back before it lands.
    expect(first.cancelled).toBe(true);
    // It glides back from halfway, not from the stack and not from the queue.
    const back = live().find((a) => a.el.dataset.entity === "click")!;
    expect(back.from).toEqual({ x: 150, y: 0 });
    // Rapid next, back, next: every glide before the last is cancelled, and the cards show the chosen step.
    next();
    prev();
    next();
    expect(animations.filter((a) => !a.cancelled).every((a) => live().includes(a))).toBe(true);
    expect(shown()).toEqual(direct);
    await finishAll();
    expect(shown()).toEqual(direct);
    expect(grid().dataset.moving).toBeUndefined();
  });

  it("stops a glide when the width changes under it, since the layout it was heading for is gone", () => {
    show(eventLoopComposition);
    next();
    expect(live().length).toBeGreaterThan(0);
    // A height change, such as the step's own content, leaves the glide alone.
    act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(live().length).toBeGreaterThan(0);
    gridWidth = 400;
    act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(live()).toEqual([]);
    expect(grid().dataset.moving).toBeUndefined();
    expect(ids("queue")).toEqual(["click", "timer", "fetch"]);
  });

  it("announces each chosen step once, never as cards land or the grid resizes", async () => {
    show(aliasingComposition);
    const status = screen.getByTestId("composition-status");
    const texts: string[] = [];
    const observer = new MutationObserver(() => texts.push(status.textContent ?? ""));
    observer.observe(status, { subtree: true, childList: true, characterData: true });
    expect(status.textContent).toBe("");

    next();
    await act(async () => {
      await Promise.resolve();
    });
    const afterStep = texts.length;
    expect(status.textContent).toContain("Step 2 of 4.");
    await finishAll();
    gridWidth = 900;
    act(() => resizeCallbacks.forEach((callback) => callback()));
    await act(async () => {
      await Promise.resolve();
    });
    expect(texts.length).toBe(afterStep);
    observer.disconnect();
  });

  it("keeps a chip for every visible reference, parallel ones included, with or without drawn lines", async () => {
    show(twoStackQueueComposition);
    next();
    await finishAll();
    const queue = within(grid().querySelector<HTMLElement>('[data-entity="q"]')!);
    expect(queue.getAllByTestId("composition-reference").map((chip) => chip.textContent)).toEqual([
      "→refers to job 1· , as front",
      "→refers to job 1· , as next out",
      "→refers to job 3· , as back",
    ]);
    // The drawing is hidden from screen readers, so the chips are said once.
    expect(screen.getByTestId("composition-connectors").getAttribute("aria-hidden")).toBe("true");
    // Focus stays on the button that stepped.
    const nextButton = screen.getByRole("button", { name: "Next" });
    nextButton.focus();
    fireEvent.click(nextButton);
    expect(document.activeElement).toBe(nextButton);
  });
});
