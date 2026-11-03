import type { UIMessageChunk } from "ai";
import { expect, it } from "vitest";
import { createContinuationStream, MAX_REPLAY_BYTES, MAX_REPLAY_CHUNKS, MAX_SUBSCRIBER_BYTES } from "../src/runtime/continuation-stream.js";

it("bounds replay bytes, chunk overhead and stalled subscribers while the producer keeps running", async () => {
  for (const delta of ["界".repeat(1024), "x"]) {
    const broadcast = createContinuationStream();
    broadcast.push({ type: "start", messageId: "reply" });
    broadcast.push({ type: "text-start", id: "t" });
    const chunk: UIMessageChunk = { type: "text-delta", id: "t", delta };
    const chunkBytes = Buffer.byteLength(JSON.stringify(chunk), "utf8");
    const byteCase = delta.length > 1;
    const count = byteCase ? Math.ceil(MAX_REPLAY_BYTES / chunkBytes) + 1 : MAX_REPLAY_CHUNKS + 1;
    // Each replay threshold must overflow while still below the other one.
    if (byteCase) expect(count + 4).toBeLessThan(MAX_REPLAY_CHUNKS);
    else expect(count * chunkBytes + 200).toBeLessThan(MAX_REPLAY_BYTES);
    for (let i = 0; i < count; i++) broadcast.push(chunk);
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
  // Independently overflow a stalled subscriber, without holding up the producer.
  const stalledBroadcast = createContinuationStream();
  const stalled = stalledBroadcast.subscribe().getReader();
  const dropped = expect(stalled.closed).rejects.toThrow("fell behind");
  const largeChunk: UIMessageChunk = { type: "text-delta", id: "t", delta: "x".repeat(1024) };
  for (let i = 0; i <= Math.ceil(MAX_SUBSCRIBER_BYTES / Buffer.byteLength(JSON.stringify(largeChunk))); i++) stalledBroadcast.push(largeChunk);
  await dropped;
  stalledBroadcast.push({ type: "finish" });
  stalledBroadcast.close();
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
