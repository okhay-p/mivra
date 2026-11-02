import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";

it("replays encrypted reasoning from tool and text steps without exposing provider details", async () => {
  const details = (id: string) => [{ type: "reasoning.encrypted", id, data: `PRIVATE-${id}`, format: "anthropic-claude-v1", index: 0 }];
  const requests: { messages: { role: string; content: unknown; reasoning_details?: unknown; tool_calls?: unknown[] }[] }[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as typeof requests[number];
    requests.push(parsed);
    const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
      id: "local", object: "chat.completion.chunk", created: 1, model: "local",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end(chunk({ reasoning_details: details("tool-step") }) + chunk({ tool_calls: [{
        index: 0, id: "check", type: "function", function: { name: "ask_multiple_choice", arguments: JSON.stringify({
          concept: "sets", question: "Which?", options: [{ text: "A" }, { text: "B" }], correctOptionIndex: 0, explanation: "A fits.",
        }) },
      }] }, "tool_calls") + "data: [DONE]\n\n");
    } else if (requests.length === 2) {
      response.end(chunk({ reasoning_details: details("text-step") }) + chunk({ content: "Choose an answer." }, "stop") + "data: [DONE]\n\n");
    } else {
      const replay = parsed.messages.filter((m) => m.role === "assistant");
      const valid = isDeepStrictEqual(replay.map((m) => m.reasoning_details), [details("tool-step"), details("text-step")]);
      response.end(chunk({ content: valid ? "Replay accepted." : "Replay missing private reasoning." }, "stop") + "data: [DONE]\n\n");
    }
  });
  const db = openDb(":memory:");
  try {
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as { port: number }).port;
    const openrouter = createOpenRouter({ apiKey: "fake-local-only", baseURL: `http://127.0.0.1:${port}` });
    const app = createApp({ db, model: () => openrouter("local"), security: { token: "local-token", allowedHosts: [] } });
    const headers = { authorization: "Bearer local-token", "content-type": "application/json" };
    const session = await (await app.request("/api/sessions", { method: "POST", headers, body: "{}" })).json() as { id: string };
    const send = async (text: string) => {
      const response = await app.request(`/api/sessions/${session.id}/chat`, { method: "POST", headers,
        body: JSON.stringify({ message: { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] } }),
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    const first = await send("Teach me sets");
    expect(first).toContain("Choose an answer.");
    const reload = await (await app.request(`/api/sessions/${session.id}/messages`, { headers })).text();
    for (const client of [first, reload]) {
      expect(client).not.toMatch(/PRIVATE-|reasoning_details|providerMetadata|signature|encrypted|correctOptionIndex/);
    }
    const second = await send("Continue");
    expect(requests).toHaveLength(3);
    const replay = requests[2]!.messages.filter((m) => m.role === "assistant");
    expect(replay.map((m) => m.reasoning_details)).toEqual([details("tool-step"), details("text-step")]);
    expect(second).toContain("Replay accepted.");
    expect(replay[0]!.tool_calls).toHaveLength(1);
    expect(replay[1]!.content).toBe("Choose an answer.");
    expect(requests[2]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    db.$client.close();
  }
});
