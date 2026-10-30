import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "../src/App.js";

it("keeps following the OS theme while the mobile sidebar is closed", async () => {
  const listeners = new Set<() => void>();
  let dark = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("prefers-color-scheme") ? dark : true; // Every width query reports mobile.
    },
    addEventListener: (_: string, listener: () => void) => {
      if (query.includes("prefers-color-scheme")) listeners.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  vi.stubGlobal("innerWidth", 390);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
  );
  localStorage.clear();

  await act(async () => void render(<App />));

  // The closed sheet renders no toggle, so nothing inside it can own the theme.
  expect(document.querySelector("[data-mobile=true]")).toBeNull();
  dark = true;
  act(() => listeners.forEach((listener) => listener()));
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
