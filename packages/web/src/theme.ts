import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

/** Also read by the inline script in index.html, which applies the theme before first paint. */
const STORAGE_KEY = "mivra-theme";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

export function loadThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system"; // Storage can be blocked; the theme just isn't remembered.
  }
}

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && darkQuery().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** The learner's theme choice: follows the OS until they pick Light or Dark, and is saved locally. */
export function useTheme() {
  const [choice, setChoice] = useState(loadThemeChoice);

  useEffect(() => {
    applyTheme(choice);
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // See loadThemeChoice.
    }
    if (choice !== "system") return;
    const query = darkQuery();
    const onChange = () => applyTheme("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  return [choice, setChoice] as const;
}
