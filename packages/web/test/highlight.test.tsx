import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodePane } from "../src/artifacts/CodePane.js";
import { dialectOf, highlightLines, PARSE_BUDGET_MS } from "../src/highlight.js";
import { MathText } from "../src/MathText.js";
import { renderMarkdown } from "../src/render-markdown.js";

const classOf = (lines: ReturnType<typeof highlightLines>, text: string) => lines?.flat().find((t) => t.text === text)?.className;

describe("highlightLines", () => {
  it("colours Python", () => {
    const lines = highlightLines("def f(x):\n    # note\n    return x + 1", "Python");
    expect(lines).toHaveLength(3);
    expect(classOf(lines, "def")).toBe("tok-keyword");
    expect(classOf(lines, "# note")).toBe("tok-comment");
    expect(classOf(lines, "1")).toBe("tok-number");
  });

  it("colours TypeScript and JSX", () => {
    const lines = highlightLines('const A = (n: number) => <div className="a">{n}</div>;', "tsx");
    expect(classOf(lines, "const")).toBe("tok-keyword");
    expect(classOf(lines, "number")).toBe("tok-typeName");
    expect(classOf(lines, '"a"')).toBe("tok-string");
  });

  it("keeps every character, including an unfinished string and a trailing newline", () => {
    for (const source of ["x = 'open\ny = 2\n", "a\n", "", "}{)(", "<div>"]) {
      const lines = highlightLines(source, "js")!;
      expect(lines.map((l) => l.map((t) => t.text).join("")).join("\n")).toBe(source);
    }
  });

  it("leaves other languages plain", () => {
    expect(highlightLines("fn main() {}", "Rust")).toBeUndefined();
    expect(highlightLines("x", "pseudocode")).toBeUndefined();
    expect(dialectOf(" JavaScript ")).toBe("");
    expect(dialectOf("constructor")).toBeUndefined();
  });
});

describe("highlighted code on the page", () => {
  it("colours the code pane, line by line", () => {
    const { container } = render(<CodePane code={{ language: "Python", source: "def f():\r\n    return 'a'\r\n" }} lines={[2]} />);
    const lines = container.querySelectorAll("[data-testid=code-line]");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.querySelector(".tok-keyword")?.textContent).toBe("def");
    expect(lines[1]!.querySelector(".tok-string")?.textContent).toBe("'a'");
    expect(lines[1]!.textContent).toContain("    return 'a'");
  });

  it("keeps the code pane plain for a language it doesn't know", () => {
    const { container } = render(<CodePane code={{ language: "Rust", source: "fn main() {}" }} lines={[]} />);
    expect(container.querySelector("[class*=tok-]")).toBeNull();
    expect(container.querySelector("[data-testid=code-line]")?.textContent).toContain("fn main() {}");
  });

  it("colours a fenced reply block with a known language and only as text", () => {
    const { tree } = renderMarkdown("```python\nprint('<b>hi</b>')\n```");
    const code = JSON.stringify(tree);
    expect(code).toContain("tok-string");
    expect(code).not.toContain('"tagName":"b"');
    const { container } = render(<MathText text={"```js\nconst x = 1;\n```\n\n```\nplain\n```"} />);
    expect(container.querySelector("pre code .tok-keyword")?.textContent).toBe("const");
    expect(container.querySelectorAll("pre code")[0]!.textContent).toBe("const x = 1;\n");
    expect(container.querySelectorAll("pre code")[1]!.querySelector("span")).toBeNull();
  });
});

describe("highlightLines on pathological input", () => {
  it("gives up on a parse that runs past its budget and shows the code plain", () => {
    // A clock that jumps past the budget on every reading, so the outcome doesn't depend on the machine's speed.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += PARSE_BUDGET_MS + 1));
    expect(highlightLines("<".repeat(4000), "jsx")).toBeUndefined();
  });
});
