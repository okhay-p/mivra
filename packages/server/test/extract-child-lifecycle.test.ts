import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentAttacher } from "../src/documents/attach.js";
import { extractInChild } from "../src/documents/extract-in-child.js";
import { DocumentError, type DocumentErrorCode } from "../src/documents/extract.js";
import { openDb } from "../src/db/client.js";
import { createSessionStore } from "../src/store/session-store.js";
import { makePdf, makePptx } from "./support/files.js";

type Tracked = ChildProcess & { exited: boolean; ready: boolean; signals: string[] };

const state = vi.hoisted(() => ({ children: [] as unknown[], fixture: undefined as string | undefined }));

/** The real fork, noting each child's signals and exit, and swapping in a misbehaving entry when asked. */
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const fixturePath = fileURLToPath(new URL("./support/extract-child-fixture.ts", import.meta.url));
  const fork = ((path: string, args: string[], options: object) => {
    const child = (state.fixture ? real.fork(fixturePath, [state.fixture], options) : real.fork(path, args, options)) as Tracked;
    child.exited = false;
    child.signals = [];
    child.ready = false;
    child.stderr?.on("data", (chunk: unknown) => {
      if (String(chunk).includes("ready")) child.ready = true;
    });
    child.once("exit", () => (child.exited = true));
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      child.signals.push(String(signal));
      return kill(signal);
    };
    state.children.push(child);
    return child;
  }) as unknown as typeof real.fork;
  return { ...real, fork, default: { ...real, fork } };
});

vi.setConfig({ testTimeout: 60_000 });

const children = () => state.children as Tracked[];
const tiny = () => makePdf([["Plenty of ordinary words to read on this page."]]);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => {
      expect(error).toBeInstanceOf(DocumentError);
      return (error as DocumentError).code as DocumentErrorCode;
    },
  );

afterEach(() => {
  for (const child of children()) if (!child.exited) child.kill("SIGKILL");
  state.children.length = 0;
  state.fixture = undefined;
});

describe("the extraction subprocess's lifetime", () => {
  it("extracts a PDF and a PPTX, and has exited by the time it returns", async () => {
    await expect(extractInChild(tiny())).resolves.toMatchObject({ kind: "pdf", pageCount: 1 });
    await expect(extractInChild(makePptx([["Graph colouring on the first slide"]]))).resolves.toMatchObject({ kind: "pptx", pageCount: 1 });
    expect(children()).toHaveLength(2);
    expect(children().every((c) => c.exited)).toBe(true);
  });

  it("reports a crash as a clean error once the child has exited", async () => {
    state.fixture = "crash";
    expect(await codeOf(extractInChild(tiny()))).toBe("failed");
    expect(children()[0]!.exited).toBe(true);
    expect(children()[0]!.signalCode).toBe("SIGABRT");
  });

  it("reports a malformed message as a clean error, and stops the child", async () => {
    state.fixture = "malformed";
    expect(await codeOf(extractInChild(tiny()))).toBe("failed");
    expect(children()[0]!.exited).toBe(true);
  });

  it("reports running out of heap as too complex", async () => {
    state.fixture = "heap";
    expect(await codeOf(extractInChild(tiny(), { maxHeapMb: 64 }))).toBe("too_complex");
    expect(children()[0]!.exited).toBe(true);
  });

  it("stops a child whose own memory passes the limit", async () => {
    state.fixture = "allocate";
    expect(await codeOf(extractInChild(tiny(), { maxRssBytes: 256 * 1024 * 1024 }))).toBe("too_complex");
    expect(children()[0]!.exited).toBe(true);
  });

  it("sends SIGTERM at the timeout, then SIGKILL after the grace period, and waits for the exit", async () => {
    state.fixture = "ignore-sigterm";
    const started = Date.now();
    const settled = vi.fn();
    // Long enough for the fixture to start through tsx and ignore SIGTERM, so only SIGKILL can stop it.
    const running = codeOf(extractInChild(tiny(), { timeoutMs: 10_000, killGraceMs: 500 })).finally(settled);
    await vi.waitFor(() => expect(children()[0]?.ready).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(children()[0]!.signals).toEqual(["SIGTERM"]), { timeout: 15_000 });
    expect(children()[0]!.exited).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    expect(await running).toBe("timeout");
    const child = children()[0]!;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(child.exited).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000 + 500 + 2_000);
  });

  it("stops the child when the client goes away", async () => {
    const controller = new AbortController();
    const running = codeOf(extractInChild(tiny(), { signal: controller.signal }));
    controller.abort();
    expect(await running).toBe("failed");
    expect(children()[0]!.exited).toBe(true);
  });
});

describe("upload slots", () => {
  it("are held until the child has exited, not just until the request gives up", async () => {
    state.fixture = "ignore-sigterm";
    const store = createSessionStore(openDb(":memory:"));
    const extract = (bytes: Uint8Array, options?: Parameters<typeof extractInChild>[1]) => extractInChild(bytes, { ...options, killGraceMs: 2_000 });
    const attach = createDocumentAttacher({ store, extract });
    const session = store.createSession().id;
    const upload = () => {
      const form = new FormData();
      form.append("file", new Blob([tiny() as BlobPart]), "a.pdf");
      const request = new Request("http://x", { method: "POST", body: form });
      return { body: request.body, contentType: request.headers.get("content-type") ?? undefined, contentLength: undefined };
    };
    const controllers = [new AbortController(), new AbortController()];
    const running = controllers.map((c) => attach(session, upload(), c.signal));
    await vi.waitFor(() => expect(children()).toHaveLength(2), { timeout: 20_000 });
    // Once each child is ignoring SIGTERM, cancel both uploads.
    await vi.waitFor(() => expect(children().every((c) => c.ready)).toBe(true), { timeout: 20_000 });
    for (const c of controllers) c.abort();
    await vi.waitFor(() => expect(children().every((c) => c.signals.includes("SIGTERM"))).toBe(true));
    expect(children().some((c) => c.exited)).toBe(false);
    expect(await attach(session, upload())).toMatchObject({ ok: false, error: { kind: "busy" } });
    for (const result of await Promise.all(running)) expect(result).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect(children().every((c) => c.exited && c.signalCode === "SIGKILL")).toBe(true);
    state.fixture = undefined;
    expect(await attach(session, upload())).toMatchObject({ ok: true });
  });
});
