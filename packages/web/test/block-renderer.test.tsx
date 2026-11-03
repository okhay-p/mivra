import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createWorkerRenderer, type BlockRenderer, type RenderRequest, type RenderResponse, type WorkerLike } from "../src/block-renderer.js";
import { BlockRendererContext, MathText } from "../src/MathText.js";
import { renderMarkdown } from "../src/render-markdown.js";

/** Stands in for the render worker: holds each request until the test answers it. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: RenderRequest[] = [];
  terminated = false;
  postMessage(message: RenderRequest) {
    this.requests.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** Answers a request as the real worker would, or as a parser that threw. */
  answer(request = this.requests.at(-1)!, fail = false) {
    this.onmessage?.({ data: fail ? { id: request.id } : { id: request.id, block: renderMarkdown(request.text) } } as MessageEvent<RenderResponse>);
  }
}

function setup(options: Parameters<typeof createWorkerRenderer>[1] = {}) {
  const workers: FakeWorker[] = [];
  const renderer = createWorkerRenderer(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, options);
  return { renderer, workers, latest: () => workers.at(-1)! };
}

const big = (body: string) => `${body} ${"x".repeat(2_100)}`;
const settled = () => act(async () => {});

describe("createWorkerRenderer", () => {
  it("renders small blocks in place, without a worker", () => {
    const { renderer, workers } = setup();
    const result = renderer.peek("**a** $x$");
    expect(result).toMatchObject({ formulas: [expect.stringContaining("katex")] });
    expect(workers).toHaveLength(0);
  });

  it("renders large blocks in the worker, and keeps the result", async () => {
    const { renderer, latest } = setup();
    const text = big("**a**");
    expect(renderer.peek(text)).toBeUndefined();
    const pending = renderer.render(text, new AbortController().signal);
    latest().answer();
    const result = await pending;
    expect(result).toMatchObject({ tree: { type: "root" } });
    expect(renderer.peek(text)).toBe(result);
  });

  it("shows a block the parser fails on as plain text", async () => {
    const { renderer, latest } = setup();
    const pending = renderer.render(big("a"), new AbortController().signal);
    latest().answer(undefined, true);
    expect(await pending).toBe("plain");
  });

  it("drops a queued render when it's cancelled, without sending it", async () => {
    const { renderer, latest } = setup();
    const first = renderer.render(big("one"), new AbortController().signal);
    const controller = new AbortController();
    const second = renderer.render(big("two"), controller.signal);
    controller.abort();
    expect(await second).toBeUndefined();
    latest().answer();
    await first;
    expect(latest().requests.map((r) => r.text)).toEqual([big("one")]);
  });

  it("lets a cancelled render that finishes promptly keep the worker", async () => {
    vi.useFakeTimers();
    const { renderer, workers, latest } = setup({ cancelGraceMs: 100 });
    const controller = new AbortController();
    const stale = renderer.render(big("old"), controller.signal);
    controller.abort();
    vi.advanceTimersByTime(50);
    latest().answer();
    expect(await stale).toBeUndefined();
    expect(renderer.peek(big("old"))).toMatchObject({ tree: { type: "root" } });
    void renderer.render(big("new"), new AbortController().signal);
    expect(workers).toHaveLength(1);
    expect(latest().requests).toHaveLength(2);
  });

  it("kills a worker stuck on a render nobody wants, and starts the next block on a new one", async () => {
    vi.useFakeTimers();
    const { renderer, workers } = setup({ cancelGraceMs: 100 });
    const controller = new AbortController();
    const stale = renderer.render(big("hostile"), controller.signal);
    const next = renderer.render(big("next"), new AbortController().signal);
    controller.abort();
    vi.advanceTimersByTime(100);
    expect(await stale).toBeUndefined();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.requests.map((r) => r.text)).toEqual([big("next")]);
    workers[1]!.answer();
    expect(await next).toMatchObject({ tree: { type: "root" } });
    // An abandoned render isn't remembered as a failure.
    expect(renderer.peek(big("hostile"))).toBeUndefined();
  });

  it("gives up on a render past its deadline, shows it as plain text, and remembers that", async () => {
    vi.useFakeTimers();
    const { renderer, workers } = setup({ timeoutMs: 1_000 });
    const slow = renderer.render(big("slow"), new AbortController().signal);
    const next = renderer.render(big("next"), new AbortController().signal);
    vi.advanceTimersByTime(999);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await slow).toBe("plain");
    expect(workers[0]!.terminated).toBe(true);
    expect(renderer.peek(big("slow"))).toBe("plain");
    // A late answer from the killed worker changes nothing.
    workers[0]!.answer(workers[0]!.requests[0]);
    workers[1]!.answer();
    expect(await next).toMatchObject({ tree: { type: "root" } });
  });

  it("shows a block as plain text if the worker crashes", async () => {
    const { renderer, workers, latest } = setup();
    const pending = renderer.render(big("a"), new AbortController().signal);
    latest().onerror?.({} as ErrorEvent);
    expect(await pending).toBe("plain");
    expect(workers[0]!.terminated).toBe(true);
    void renderer.render(big("b"), new AbortController().signal);
    expect(workers).toHaveLength(2);
  });

  it("cancels everything when disposed", async () => {
    const { renderer, latest } = setup();
    const running = renderer.render(big("a"), new AbortController().signal);
    const queued = renderer.render(big("b"), new AbortController().signal);
    renderer.dispose();
    expect(await running).toBeUndefined();
    expect(await queued).toBeUndefined();
    expect(latest().terminated).toBe(true);
  });

  it("stops an idle worker when disposed", async () => {
    const { renderer, latest } = setup();
    const pending = renderer.render(big("a"), new AbortController().signal);
    latest().answer();
    await pending;
    renderer.dispose();
    expect(latest().terminated).toBe(true);
  });

  it("replaces an idle worker that fails, without throwing", async () => {
    const { renderer, workers, latest } = setup();
    const pending = renderer.render(big("a"), new AbortController().signal);
    latest().answer();
    await pending;
    expect(() => latest().onerror?.({} as ErrorEvent)).not.toThrow();
    expect(workers[0]!.terminated).toBe(true);
    const next = renderer.render(big("b"), new AbortController().signal);
    expect(workers).toHaveLength(2);
    latest().answer();
    expect(await next).toMatchObject({ tree: { type: "root" } });
  });
});

describe("the render worker", () => {
  it("answers a request with the rendered block, or with nothing if the parser throws", async () => {
    const posted: RenderResponse[] = [];
    const scope = { onmessage: null as ((event: { data: RenderRequest }) => void) | null, postMessage: (message: RenderResponse) => posted.push(message) };
    vi.stubGlobal("self", scope);
    vi.resetModules();
    await import("../src/render.worker.js");
    scope.onmessage!({ data: { id: 7, text: "**a** $x$" } });
    expect(posted[0]).toEqual({ id: 7, block: renderMarkdown("**a** $x$") });
    vi.doMock("../src/render-markdown.js", () => ({
      renderMarkdown: () => {
        throw new Error("boom");
      },
    }));
    vi.resetModules();
    await import("../src/render.worker.js");
    scope.onmessage!({ data: { id: 8, text: "x" } });
    expect(posted[1]).toEqual({ id: 8 });
    vi.doUnmock("../src/render-markdown.js");
  });
});

describe("MathText with a render worker", () => {
  const mount = (renderer: BlockRenderer, text: string) => {
    const view = render(
      <BlockRendererContext.Provider value={renderer}>
        <MathText text={text} />
      </BlockRendererContext.Provider>,
    );
    return {
      container: view.container,
      rerender: (next: string) =>
        view.rerender(
          <BlockRendererContext.Provider value={renderer}>
            <MathText text={next} />
          </BlockRendererContext.Provider>,
        ),
      unmount: view.unmount,
    };
  };

  it("shows a large block as plain text until the worker renders it", async () => {
    const { renderer, latest } = setup();
    const text = big("**bold** $x$");
    const { container } = mount(renderer, text);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("p.math-text-literal")?.textContent).toBe(text);
    await settled();
    act(() => latest().answer());
    await waitFor(() => expect(container.querySelector("strong")?.textContent).toBe("bold"));
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".math-text-literal")).toBeNull();
  });

  it("keeps showing a streaming block's last rendering until the next arrives", async () => {
    const { renderer, latest } = setup();
    const { container, rerender } = mount(renderer, big("**one**"));
    await settled();
    act(() => latest().answer());
    await waitFor(() => expect(container.querySelector("strong")?.textContent).toBe("one"));
    rerender(big("**one** **two**"));
    await settled();
    expect(container.querySelector("strong")?.textContent).toBe("one");
    expect(container.querySelector(".math-text-literal")).toBeNull();
    act(() => latest().answer());
    await waitFor(() => expect(container.querySelectorAll("strong")).toHaveLength(2));
  });

  it("keeps a block that grows past the main thread's limit rendered while the worker catches up", async () => {
    const { renderer } = setup();
    const { container, rerender } = mount(renderer, "**short**");
    expect(container.querySelector("strong")?.textContent).toBe("short");
    rerender(big("**short**"));
    await settled();
    expect(container.querySelector("strong")?.textContent).toBe("short");
  });

  it("cancels a stale render when the text changes, and every render when it unmounts", async () => {
    const { renderer, workers } = setup();
    const a = mount(renderer, `${big("a")}\n\n${big("b")}`);
    await settled();
    // The first block is running, the second queued.
    a.rerender(`${big("a")}\n\n${big("c")}`);
    await settled();
    a.unmount();
    await settled();
    expect(workers[0]!.requests.map((r) => r.text.slice(0, 1))).toEqual(["a"]);
    act(() => workers[0]!.answer());
    await settled();
    expect(workers[0]!.requests).toHaveLength(1);
  });

  it("shows a block that times out as plain text, and keeps the rest of the reply", async () => {
    vi.useFakeTimers();
    const { renderer } = setup({ timeoutMs: 1_000 });
    const hostile = "*a ".repeat(8_000);
    const { container } = mount(renderer, `**before**\n\n${hostile}`);
    await act(async () => {});
    expect(container.querySelector("strong")?.textContent).toBe("before");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("p.math-text-literal")?.textContent).toBe(hostile);
  });
});

describe("MathText with a very long reply", () => {
  it("mounts it in batches", async () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => `**p${i}** ${"word ".repeat(100)}`);
    const { container } = render(<MathText text={paragraphs.join("\n\n")} />);
    const first = container.querySelectorAll("strong").length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(200);
    await waitFor(() => expect(container.querySelectorAll("strong")).toHaveLength(200), { timeout: 10_000 });
    expect(container.querySelector("strong")?.textContent).toBe("p0");
    expect([...container.querySelectorAll("strong")].at(-1)?.textContent).toBe("p199");
  }, 20_000);

  it("mounts the blocks after one longer than a batch", async () => {
    const { container } = render(<MathText text={`${"x".repeat(45_000)}\n\n**after**`} />);
    await waitFor(() => expect(container.querySelector("strong")?.textContent).toBe("after"), { timeout: 5_000 });
  });

  it("shows text that grows past a batch without dropping what was shown", async () => {
    const { container, rerender } = render(<MathText text={"**a**"} />);
    rerender(<MathText text={`**a**\n\n${"word ".repeat(5_000)}\n\n**b**`} />);
    expect(container.querySelector("strong")?.textContent).toBe("a");
    await waitFor(() => expect(container.querySelectorAll("strong")).toHaveLength(2));
  });
});
