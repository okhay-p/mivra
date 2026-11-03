import type { UIMessageChunk } from "ai";
import { expect, it } from "vitest";
import { createContinuationStream, MAX_REPLAY_BYTES, MAX_REPLAY_CHUNKS, MAX_SUBSCRIBER_BYTES } from "../src/runtime/continuation-stream.js";

it("bounds replay bytes, chunk overhead and stalled subscribers while the producer keeps running", async () => {
  for (const delta of ["x".repeat(1024), "x"]) {
    const broadcast = createContinuationStream();
    const stalled = broadcast.subscribe().getReader();
    const dropped = expect(stalled.closed).rejects.toThrow("fell behind");
    broadcast.push({ type: "start", messageId: "reply" });
    broadcast.push({ type: "text-start", id: "t" });
    const chunk: UIMessageChunk = { type: "text-delta", id: "t", delta };
    // Exceed both the byte and object-count limits, with no consuming subscriber.
    const count = Math.max(6000, MAX_REPLAY_CHUNKS + 1, Math.ceil(MAX_SUBSCRIBER_BYTES / Buffer.byteLength(JSON.stringify(chunk))) + 1);
    for (let i = 0; i < count; i++) broadcast.push(chunk);
    await dropped;
    const late = broadcast.subscribe();
    const received = (async () => {
      const chunks: UIMessageChunk[] = [];
      for await (const chunk of late) chunks.push(chunk);
      return chunks;
    })();
    broadcast.push({ type: "text-end", id: "t" });
    broadcast.push({ type: "finish" });
    broadcast.close();
    // Overflow never replays an invalid suffix or an unbounded prefix. This empty envelope
    // waits for completion, which invokes the client's ordinary /messages reconciliation.
    expect(await received).toEqual([{ type: "start", messageId: "reply" }, { type: "finish" }]);
  }
  // Ordinary late replay preserves every public part, including reasoning and artifacts.
  const normal = createContinuationStream();
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: "normal" },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "Thinking." },
    { type: "reasoning-end", id: "r" },
    { type: "data-artifact", data: { id: "artifact" } },
    { type: "finish" },
  ];
  expect(Buffer.byteLength(JSON.stringify(chunks))).toBeLessThan(MAX_REPLAY_BYTES);
  for (const chunk of chunks) normal.push(chunk);
  const late = normal.subscribe();
  normal.close();
  const replay: UIMessageChunk[] = [];
  for await (const chunk of late) replay.push(chunk);
  expect(replay).toEqual(chunks);
});
