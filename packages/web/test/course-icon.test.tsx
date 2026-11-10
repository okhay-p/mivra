import { courseIcons } from "@mivra/protocol";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CourseIcon } from "../src/CourseIcon.js";

const shown = (icon: string | null | undefined) => render(<CourseIcon icon={icon} />).container.querySelector("svg")!;

describe("CourseIcon", () => {
  it("draws every icon on the server's list", () => {
    for (const name of courseIcons) {
      expect(shown(name).getAttribute("data-icon")).toBe(name);
      expect(shown(name).getAttribute("class")).toContain(`lucide-${name}`);
    }
  });

  it.each([null, undefined, "", "rocket", "constructor", "__proto__"])("falls back to a graduation cap for %j", (icon) => {
    expect(shown(icon).getAttribute("class")).toContain("lucide-graduation-cap");
  });
});
