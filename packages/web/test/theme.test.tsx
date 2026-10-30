import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadThemeChoice, useTheme } from "../src/theme.js";

function stubOs(dark: boolean) {
  const query = { matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => query);
  return {
    query,
    change(next: boolean) {
      query.matches = next;
      for (const [, listener] of query.addEventListener.mock.calls) listener();
    },
  };
}
const isDark = () => document.documentElement.classList.contains("dark");

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("follows the OS by default, including when it changes", () => {
    const os = stubOs(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe("system");
    expect(isDark()).toBe(true);
    act(() => os.change(false));
    expect(isDark()).toBe(false);
  });

  it("saves an explicit choice, which then overrides the OS", () => {
    const os = stubOs(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]("light"));
    expect(isDark()).toBe(false);
    expect(loadThemeChoice()).toBe("light");
    expect(os.query.removeEventListener).toHaveBeenCalled();
  });

  it("forgets the choice when going back to System", () => {
    stubOs(false);
    localStorage.setItem("mivra-theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(isDark()).toBe(true);
    act(() => result.current[1]("system"));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem("mivra-theme")).toBeNull();
  });

  it("treats an unknown saved value as System", () => {
    localStorage.setItem("mivra-theme", "sepia");
    expect(loadThemeChoice()).toBe("system");
  });
});
