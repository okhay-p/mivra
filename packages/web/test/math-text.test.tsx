import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MathText } from "../src/MathText.js";

const block = (text: string) => render(<MathText text={text} />).container;
const inline = (text: string) => render(<MathText text={text} mode="inline" />).container;

describe("MathText rendering", () => {
  it("renders markdown blocks", () => {
    const c = block("**bold** and *soft*\n\n- one\n- two\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(c.querySelector("strong")?.textContent).toBe("bold");
    expect(c.querySelector("em")?.textContent).toBe("soft");
    expect(c.querySelectorAll("li")).toHaveLength(2);
    expect(c.querySelector("pre code")?.textContent).toContain("code");
    expect(c.querySelector(".math-text-scroll table td")?.textContent).toBe("1");
  });

  it("renders inline and display maths", () => {
    const c = block("So $x^2$ holds.\n\n$$\n\\sum_i i\n$$");
    expect(c.querySelector("p .katex")).not.toBeNull();
    expect(c.querySelector(".katex-display")).not.toBeNull();
    expect(c.textContent).not.toContain("$");
  });

  it("treats a one-line $$x$$ as display maths", () => {
    expect(block("$$x^2$$").querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps LaTeX that markdown would otherwise eat", () => {
    const annotation = block("$\\{a, b\\} \\cup a*b*c$").querySelector("annotation");
    expect(annotation?.textContent).toBe("\\{a, b\\} \\cup a*b*c");
  });

  it("keeps reply headings below the card titles' level", () => {
    const c = block("# One\n\n## Two\n\n### Three");
    expect(c.querySelector("h1, h2, h3")).toBeNull();
    expect(c.querySelectorAll("h4, h5")).toHaveLength(3);
  });

  it("re-renders when the text changes", () => {
    const { container, rerender } = render(<MathText text="**one**" />);
    rerender(<MathText text="**two**" />);
    expect(container.querySelector("strong")?.textContent).toBe("two");
  });
});

describe("MathText inline mode", () => {
  it("has no block element and keeps inline markup and maths", () => {
    const c = inline("Sort **fast**: $x^2$");
    expect(c.querySelector("p, div")).toBeNull();
    expect(c.querySelector("span.math-text strong")?.textContent).toBe("fast");
    expect(c.querySelector(".katex")).not.toBeNull();
    expect(c.querySelector(".katex-display")).toBeNull();
  });

  it.each(["1. Sort", "- 5", "# 1", "> x", "---"])("leaves %j as written", (text) => {
    const c = inline(text);
    expect(c.textContent).toBe(text);
    expect(c.querySelector("ol, ul, li, h1, h4, blockquote, hr, p")).toBeNull();
  });

  it("doesn't build a table or display maths from its text", () => {
    const c = inline("| a |\n|---|\n| 1 |\n\n$$\nx\n$$");
    expect(c.querySelector("table, .katex-display, pre")).toBeNull();
  });

  it("shows a link as its text, since it may sit inside a button", () => {
    const c = inline("[site](https://example.com)");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toBe("site");
  });
});

describe("MathText dollar signs", () => {
  it.each([
    "costs $5 and $10",
    "from $5-$10 today",
    "$5, $10 and $20",
    "($5) and ($6)",
    "pay US$ 5 or CA$ 7",
    "just $5",
    "$HOME and $PATH",
    "costs $5 and **$10** now",
  ])("leaves %j as text", (text) => {
    const c = block(text);
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe(text.replaceAll("**", ""));
  });

  it("still finds the formula after a plain dollar", () => {
    const c = block("That's $5, and $x^2$ is $y$.");
    expect([...c.querySelectorAll("annotation")].map((a) => a.textContent)).toEqual(["x^2", "y"]);
    expect(c.textContent).toContain("That's $5, and");
  });

  it("respects an escaped dollar", () => {
    const c = block("\\$x\\$ stays");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe("$x$ stays");
  });

  it("leaves dollars in code alone", () => {
    const c = block("`$5 and $10`\n\n```\necho $5 $6\n```\n\n    $7 and $8");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toContain("$5 and $10");
    expect(c.textContent).toContain("echo $5 $6");
    expect(c.textContent).toContain("$7 and $8");
    expect(c.textContent).not.toContain("\\");
  });

  it("handles more plain dollars than its pass limit without failing", () => {
    expect(block("$1, ".repeat(200)).textContent).toContain("$1");
  });
});

describe("MathText safety", () => {
  it.each(["<script>window.pwned = 1</script>", "<img src=x onerror=\"window.pwned = 1\">", "a <b onclick=\"x()\">b</b>"])("shows raw HTML as inert text: %s", (html) => {
    for (const c of [block(html), inline(html)]) {
      expect(c.querySelector("script, img, b, [onerror], [onclick]")).toBeNull();
    }
    expect((window as { pwned?: number }).pwned).toBeUndefined();
    expect(block(html).textContent).toContain(html.includes("script") ? "window.pwned" : "<");
  });

  it.each(["$\\href{javascript:alert(1)}{x}$", "$\\url{javascript:alert(1)}$", "$\\includegraphics{https://evil.example/x.png}$", "$\\htmlClass{a}{x}$", "$\\htmlData{a=b}{x}$"])(
    "KaTeX stays untrusted: %s",
    (text) => {
      const c = block(text);
      expect(c.querySelector("a, img, [data-a], .a")).toBeNull();
      expect(c.innerHTML).not.toContain('href="javascript');
    },
  );

  it("opens http, https and mailto links in a new tab", () => {
    const c = block("[a](https://example.com) [b](http://example.com) [c](mailto:me@example.com)");
    const links = [...c.querySelectorAll("a")];
    expect(links.map((a) => a.protocol)).toEqual(["https:", "http:", "mailto:"]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java&#9;script:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "/relative", "#hash", "//example.com"])(
    "doesn't make a link of %s",
    (url) => {
      const c = block(`[click me](${url})`);
      expect(c.querySelector("a")).toBeNull();
      expect(c.textContent).toContain("click me");
    },
  );

  it("shows an image's alt text and never loads it", () => {
    for (const text of ["![a diagram](https://evil.example/x.png?leak=1)", "![a diagram][r]\n\n[r]: https://evil.example/x.png"]) {
      const c = block(text);
      expect(c.querySelector("img")).toBeNull();
      expect(c.textContent?.trim()).toBe("a diagram");
      expect(c.innerHTML).not.toContain("evil.example");
    }
    expect(inline("![a diagram](https://evil.example/x.png)").querySelector("img")).toBeNull();
  });
});

describe("MathText robustness", () => {
  it("shows invalid LaTeX as its source, keeping the rest of the message", () => {
    const c = block("Before $\\frac{1}{$ and $\\notacommand{x}$ after");
    expect(c.textContent).toContain("Before");
    expect(c.textContent).toContain("\\notacommand{x}");
    expect(c.textContent).toContain("after");
  });

  it("renders every prefix of a reply, as streaming would", () => {
    const reply = "# Title\n\n**bold** $x^2$ and\n\n$$\n\\frac{a}{b}\n$$\n\n| a | $b$ |\n|---|---|\n| `1` | [l](https://e.com) |\n\n```js\nlet a\n```\n";
    for (let i = 0; i <= reply.length; i++) {
      const { unmount } = render(<MathText text={reply.slice(0, i)} />);
      unmount();
    }
  }, 30_000);

  // 200 levels because jsdom crawls on more. Chromium takes under a second for 2000.
  it("survives deep nesting and a macro bomb", () => {
    expect(block(">".repeat(200) + " deep").textContent).toContain("deep");
    expect(block("$\\def\\a{\\a\\a}\\a$").textContent).toContain("\\def");
  });

  it("renders nothing for empty text", () => {
    expect(block("").textContent).toBe("");
  });
});

describe("MathText failure fallback", () => {
  it("shows plain text if rendering throws", async () => {
    vi.resetModules();
    vi.doMock("react-markdown", () => ({
      default: ({ children }: { children: string }) => {
        if (children.includes("boom")) throw new Error("boom");
        return <em>{children}</em>;
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { MathText: Mocked } = await import("../src/MathText.js");
    const { container, rerender } = render(<Mocked text="boom text" />);
    expect(container.textContent).toBe("boom text");
    rerender(<Mocked text="fine" />);
    expect(container.querySelector("em")?.textContent).toBe("fine");
    vi.doUnmock("react-markdown");
  });
});
