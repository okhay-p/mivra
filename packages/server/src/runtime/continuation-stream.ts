import type { UIMessageChunk } from "ai";

// Includes serialized protocol overhead, not just text. Chunk count also bounds object overhead.
export const MAX_REPLAY_BYTES = 1024 * 1024;
export const MAX_REPLAY_CHUNKS = 8192;
export const MAX_SUBSCRIBER_BYTES = 2 * 1024 * 1024;

/** Bounded public replay; subscribers never hold up the server-owned provider pump. */
export function createContinuationStream() {
  let chunks: UIMessageChunk[] = [];
  let bytes = 0;
  let replayable = true;
  let start: Extract<UIMessageChunk, { type: "start" }> | undefined;
  type Subscriber = { controller: ReadableStreamDefaultController<UIMessageChunk>; reconcileOnly: boolean };
  const subscribers = new Set<Subscriber>();
  const size = (chunk: UIMessageChunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8");
  return {
    subscribe() {
      let subscriber: Subscriber;
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          subscriber = { controller, reconcileOnly: !replayable };
          // Synchronous registration and replay leave no gap. Once replay exceeds its budget,
          // send only a valid empty message envelope and wait for completion. The client's normal
          // onFinish reconciles the full reply (including thinking and artifacts) from /messages.
          if (replayable) for (const chunk of chunks) controller.enqueue(chunk);
          else if (start) controller.enqueue(start);
          subscribers.add(subscriber);
        },
        cancel() { subscribers.delete(subscriber); },
      }, { highWaterMark: MAX_SUBSCRIBER_BYTES, size });
    },
    push(chunk: UIMessageChunk) {
      if (chunk.type === "start") start = chunk;
      const chunkBytes = size(chunk);
      if (replayable) {
        if (bytes + chunkBytes > MAX_REPLAY_BYTES || chunks.length >= MAX_REPLAY_CHUNKS) {
          replayable = false;
          chunks = [];
          bytes = 0;
        } else {
          chunks.push(chunk);
          bytes += chunkBytes;
        }
      }
      for (const subscriber of subscribers) {
        if (subscriber.reconcileOnly && !["finish", "error", "abort"].includes(chunk.type)) continue;
        if ((subscriber.controller.desiredSize ?? 0) < chunkBytes) {
          subscriber.controller.error(new Error("Reply subscription fell behind. Refocus to reconnect."));
          subscribers.delete(subscriber);
        } else subscriber.controller.enqueue(chunk);
      }
    },
    close() {
      for (const subscriber of subscribers) subscriber.controller.close();
      subscribers.clear();
      chunks = [];
      bytes = 0;
      start = undefined;
    },
  };
}
