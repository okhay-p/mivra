import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, vi } from "vitest";
import { MathText } from "../src/MathText.js";

// A file's first role query takes about a second as dom-testing-library builds its role tables, and its first
// render and formula take hundreds of milliseconds more while the code warms up. Without this, that lands on
// whichever test comes first, and with every core busy that can cost it the 5 seconds a test gets.
beforeAll(() => {
  render(createElement("button", null, createElement(MathText, { text: "**a** $x$" })));
  screen.getByRole("button");
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// jsdom has no layout, so neither of these exists there.
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoResizeObserver;
Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } });
