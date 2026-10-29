import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createRegistry, resolveModel } from "../src/model.js";

/** An OpenAI-style chat-completions SSE body. */
function chatCompletionStream(text: string) {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({
      id: "gen-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test/model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop", { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) +
    "data: [DONE]\n\n"
  );
}

describe("openrouter provider", () => {
  it("keeps colons inside the OpenRouter model id", () => {
    const model = resolveModel("openrouter:meta-llama/llama-3.3-70b-instruct:free", createRegistry({ openrouterApiKey: "k" }));
    expect(typeof model === "object" && model.modelId).toBe("meta-llama/llama-3.3-70b-instruct:free");
  });

  it("streams from OpenRouter's chat completions endpoint with the API key", async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(chatCompletionStream("Hello from OpenRouter"), {
        headers: { "content-type": "text/event-stream" },
      });
    };

    const registry = createRegistry({ openrouterApiKey: "or-test-key", fetch: fakeFetch });
    const result = streamText({
      model: resolveModel("openrouter:anthropic/claude-sonnet-5.5", registry),
      prompt: "hi",
    });

    expect(await result.text).toBe("Hello from OpenRouter");
    const [request] = requests;
    expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer or-test-key");
    expect(request?.headers.get("x-openrouter-title")).toBe("Mivra");
    expect(request?.body.model).toBe("anthropic/claude-sonnet-5.5");
    expect(request?.body.stream).toBe(true);
  });
});
