// Parses and typesets blocks off the main thread. See `block-renderer.ts` for the other end.
import type { RenderRequest, RenderResponse } from "./block-renderer.js";
import { renderMarkdown } from "./render-markdown.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage(message: RenderResponse): void;
};

scope.onmessage = (event) => {
  const { id, text } = event.data;
  let response: RenderResponse;
  try {
    response = { id, block: renderMarkdown(text) };
  } catch {
    response = { id };
  }
  scope.postMessage(response);
};
