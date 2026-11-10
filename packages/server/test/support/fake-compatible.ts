import { Hono } from "hono";

/**
 * A stand-in for an OpenAI-compatible service (issue #69): `GET <base>/models` and streamed
 * `POST <base>/chat/completions`. Nothing in the suites calls a real provider.
 *
 * Models behave by id:
 * - `no-tools`: answers in text and never calls a tool.
 * - `no-continue`: calls the tool, then ends without text after its result.
 * - `slow`: never answers until the request is aborted.
 * - `bad-stream`: answers 200 with a body that isn't an event stream.
 * - `tools-rejected`: answers 400 saying tools aren't supported.
 * - anything in `unknownModels`: answers 404 "model does not exist".
 * - anything else: calls `record_number` when offered (the compatibility test), then says "done"; otherwise says
 *   "Hello from <name> (<model>)." so a test can see which endpoint answered.
 */
export interface FakeCompatibleOptions {
  /** Shown in replies, to tell endpoints apart. */
  name?: string;
  /** When set, requests must carry `Authorization: Bearer <key>`; the 401 echoes the key, as some services do. */
  key?: string;
  /** What `/models` answers: a list of ids, an HTTP status, or a raw body. */
  models?: string[] | { status: number } | { raw: string };
  unknownModels?: string[];
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const chunk = (model: string, delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = (model: string) =>
  `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`;

export function createFakeCompatible(options: FakeCompatibleOptions = {}) {
  const requests: FakeRequest[] = [];
  const state = { ...options };
  const app = new Hono();

  app.use("*", async (c, next) => {
    const body = c.req.method === "POST" ? ((await c.req.raw.clone().json().catch(() => null)) as Record<string, unknown> | null) : null;
    requests.push({ method: c.req.method, path: new URL(c.req.url).pathname, authorization: c.req.header("authorization") ?? null, body });
    if (state.key && c.req.header("authorization") !== `Bearer ${state.key}`) {
      return c.json({ error: { message: `Incorrect API key provided: ${c.req.header("authorization")?.slice(7) ?? "none"}`, type: "invalid_request_error" } }, 401);
    }
    await next();
  });

  app.get("*", async (c, next) => {
    if (!c.req.path.endsWith("/models")) return next();
    const models = state.models ?? ["fake-chat", "fake-mini"];
    if (Array.isArray(models)) return c.json({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) });
    if ("status" in models) return c.json({ error: { message: "Not here" } }, models.status as 404);
    return c.body(models.raw, 200, { "content-type": "application/json" });
  });

  app.post("*", async (c, next) => {
    if (!c.req.path.endsWith("/chat/completions")) return next();
    const body = (await c.req.json()) as { model: string; stream?: boolean; messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] };
    const model = body.model;
    if (state.unknownModels?.includes(model)) {
      return c.json({ error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, code: "model_not_found" } }, 404);
    }
    if (model === "tools-rejected") return c.json({ error: { message: "This model does not support tools." } }, 400);
    if (model === "bad-stream") return c.text("<html>hello</html>");
    if (model === "slow") {
      await new Promise<void>((resolve) => c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true }));
      return c.text("", 499 as 400);
    }
    if (!body.stream) return c.json({ error: { message: "Only streaming is supported here" } }, 400);
    const afterTool = body.messages.some((m) => m.role === "tool");
    const offersTest = body.tools?.some((t) => t.function.name === "record_number");
    let events: string[];
    if (offersTest && !afterTool && model !== "no-tools") {
      const prompt = JSON.stringify(body.messages);
      const number = Number(/number (\d+)/.exec(prompt)?.[1] ?? 0);
      events = [
        chunk(model, { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "record_number", arguments: "" } }] }),
        chunk(model, { tool_calls: [{ index: 0, function: { arguments: `{"number": ${number}}` } }] }),
        chunk(model, {}, "tool_calls"),
      ];
    } else if (afterTool && model === "no-continue") {
      events = [chunk(model, { role: "assistant", content: "" }), chunk(model, {}, "stop")];
    } else {
      const text = offersTest ? "done" : `Hello from ${state.name ?? "the fake"} (${model}).`;
      events = [chunk(model, { role: "assistant", content: text.slice(0, 6) }), chunk(model, { content: text.slice(6) }), chunk(model, {}, "stop")];
    }
    const all = [...events, usage(model), "data: [DONE]\n\n"];
    return c.body(all.join(""), 200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  });

  return {
    app,
    requests,
    set(next: Partial<FakeCompatibleOptions>) {
      Object.assign(state, next);
    },
    /** A fetch that answers from the fake, for any host: `http://fake.test/v1/...`. */
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return app.fetch(request);
    }) as typeof fetch,
  };
}
