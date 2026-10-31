import { render } from "@testing-library/react";
import katex from "katex";
import { describe, expect, it, vi } from "vitest";
import { MathText } from "../src/MathText.js";
import { splitBlocks } from "../src/math-syntax.js";

const block = (text: string) => render(<MathText text={text} />).container;
const math = (text: string) => render(<MathText text={text} mode="math" />).container;
const formulas = (c: Element) => [...c.querySelectorAll("annotation")].map((a) => a.textContent);

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

describe("MathText math mode", () => {
  it("has no block element and renders only formulas", () => {
    const c = math("Sort **fast**: $x^2$");
    expect(c.querySelector("p, div")).toBeNull();
    expect(c.querySelector("span.math-text strong")).toBeNull();
    expect(c.querySelector("span.math-text")?.firstChild?.textContent).toBe("Sort **fast**: ");
    expect(formulas(c)).toEqual(["x^2"]);
    expect(c.querySelector(".katex-display")).toBeNull();
  });

  it.each(["2*3*4", "2**3**4", "a_b_c", "1. Sort", "- 5", "# 1", "> x", "---", "[site](https://example.com)", "![a](https://e.com/x.png)", "`code`", "<b>x</b>", "a\\*b", "| a |\n|---|\n| 1 |", "x\n\n  y"])(
    "leaves %j exactly as written",
    (text) => {
      const c = math(text);
      expect(c.textContent).toBe(text);
      expect(c.querySelector("strong, em, a, img, code, b, ol, ul, li, h1, h4, blockquote, hr, p, table")).toBeNull();
    },
  );

  it("shows `$$` as written rather than as display maths", () => {
    const c = math("$$x$$ and\n\n$$\nx\n$$");
    expect(c.textContent).toBe("$$x$$ and\n\n$$\nx\n$$");
    expect(c.querySelector(".katex")).toBeNull();
  });

  it("treats backticks as text, and `\\$` as a dollar", () => {
    const c = math("costs $5 and $10, see `$x$`, \\$y\\$");
    expect(formulas(c)).toEqual(["x"]);
    expect(c.querySelector("code")).toBeNull();
    expect(c.querySelector("span.math-text")?.firstChild?.textContent).toBe("costs $5 and $10, see `");
    expect(c.querySelector("span.math-text")?.lastChild?.textContent).toBe("`, $y$");
  });

  it("doesn't pair dollars across a blank line", () => {
    const c = math("$a\n\nb$");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe("$a\n\nb$");
  });

  it("allows `\\$` inside a formula", () => {
    expect(formulas(math("$a\\$b$"))).toEqual(["a\\$b"]);
  });

  it("shows invalid LaTeX as its source", () => {
    expect(math("Before $\\frac{1}{$ after").textContent).toContain("\\frac{1}{");
  });

  it("keeps KaTeX untrusted", () => {
    const c = math("$\\href{javascript:alert(1)}{x}$ $\\includegraphics{https://evil.example/x.png}$");
    expect(c.querySelector("a, img")).toBeNull();
  });
});

const CURRENCY_CASES = [
  "costs $5 and $10",
  "from $5-$10 today",
  "$5, $10 and $20",
  "($5) and ($6)",
  "pay US$ 5 or CA$ 7",
  "just $5",
  "$HOME and $PATH",
];

describe.each([
  ["block", block],
  ["math", math],
] as const)("MathText dollar signs in %s mode", (_mode, renderIn) => {
  it.each(CURRENCY_CASES)("leaves %j as text", (text) => {
    const c = renderIn(text);
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe(text);
  });

  it("still finds the formula after a plain dollar", () => {
    const c = renderIn("That's $5, and $x^2$ is $y$.");
    expect(formulas(c)).toEqual(["x^2", "y"]);
    expect(c.textContent).toContain("That's $5, and");
  });

  it("keeps a plain dollar plain whatever the formula after it", () => {
    expect(formulas(renderIn("$5 and $x$"))).toEqual(["x"]);
    expect(formulas(renderIn("$5 or 6$"))).toEqual(["5 or 6"]);
  });

  it("respects escaped dollars after plain ones", () => {
    const c = renderIn("$5 and $10 \\$x\\$");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe("$5 and $10 $x$");
  });

  it.each([40, 41, 500])("keeps %i plain dollars in one paragraph as text", (count) => {
    const text = "$1, ".repeat(count).trim();
    const c = renderIn(text);
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe(text);
  });
});

describe("MathText dollars in markdown", () => {
  it("doesn't let a dollar pair across a code span", () => {
    const c = block("costs $5 and $10, see `$x$` ");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.querySelector("code")?.textContent).toBe("$x$");
    expect(c.textContent?.trim()).toBe("costs $5 and $10, see $x$");
  });

  it("still finds formulas around a code span", () => {
    const c = block("$x$ and `y` and $z$, then $5 `a` $w$");
    expect(formulas(c)).toEqual(["x", "z", "w"]);
    expect([...c.querySelectorAll("code")].map((e) => e.textContent)).toEqual(["y", "a"]);
  });

  it("keeps markup between plain dollars", () => {
    const c = block("costs $5 and **$10** now");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.querySelector("strong")?.textContent).toBe("$10");
    expect(c.textContent).toBe("costs $5 and $10 now");
  });

  it("allows `\\$` inside a formula, and doesn't close on it", () => {
    expect(formulas(block("$a\\$b$ end"))).toEqual(["a\\$b"]);
  });

  it("applies the rule inside table cells", () => {
    const c = block("| a | b |\n|---|---|\n| $5 | $10 |\n| $x$ | `$y$` |");
    expect(formulas(c)).toEqual(["x"]);
    expect(c.querySelector("code")?.textContent).toBe("$y$");
  });

  it("leaves dollars in code alone", () => {
    const c = block("`$5 and $10`\n\n```\necho $5 $6\n```\n\n    $7 and $8");
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toContain("$5 and $10");
    expect(c.textContent).toContain("echo $5 $6");
    expect(c.textContent).toContain("$7 and $8");
    expect(c.textContent).not.toContain("\\");
  });
});

describe("splitBlocks", () => {
  it("splits at blank lines before a new top-level block", () => {
    expect(splitBlocks("one\n\ntwo\n\n\nthree")).toEqual(["one\n\n", "two\n\n\n", "three"]);
  });

  it.each([
    ["a fence", "```\na\n\nb\n```"],
    ["a tilde fence", "~~~\na\n\n```\n\nb\n~~~"],
    ["an unclosed fence", "```\na\n\nb"],
    ["a `$$` block", "$$\na\n\nb\n$$"],
    ["a loose list", "- a\n\n- b\n\n1. c"],
    ["a list item's second paragraph", "1. a\n\n   b"],
    ["indented code", "    a\n\n    b"],
    ["anything with a reference", "[a][r]\n\nb\n\n[r]: https://e.com"],
    ["anything with a footnote", "a[^1]\n\nb\n\n[^1]: c"],
  ])("keeps %s in one piece", (_name, text) => {
    expect(splitBlocks(text)).toEqual([text]);
  });

  it("doesn't take a one-line `$$x$$` or code span for an opening fence", () => {
    expect(splitBlocks("$$x$$\n\none")).toHaveLength(2);
    expect(splitBlocks("```a```\n\none")).toHaveLength(2);
  });

  it("splits before a list that follows a paragraph, and after one", () => {
    expect(splitBlocks("a\n\n- b\n\n- c\n\nd")).toEqual(["a\n\n", "- b\n\n- c\n\n", "d"]);
    expect(splitBlocks("a\n- b\n\n  c")).toEqual(["a\n- b\n\n  c"]);
  });

  it("splits again after a closed fence", () => {
    expect(splitBlocks("```\na\n\nb\n```\n\nc")).toEqual(["```\na\n\nb\n```\n\n", "c"]);
  });
});

describe("MathText across blocks", () => {
  it("renders constructs the same as a single parse would", () => {
    const c = block("[a][r] one\n\n![pic][r]\n\n[r]: https://e.com\n\n1. x\n\n   y\n\n2. z\n\n```\nk\n\nl\n```\n\n$$\nm\n\nn\n$$\n\nend");
    expect(c.querySelector("a")?.getAttribute("href")).toBe("https://e.com/");
    expect(c.querySelectorAll("ol")).toHaveLength(1);
    expect(c.querySelectorAll("ol > li")).toHaveLength(2);
    expect(c.querySelector("ol pre")).toBeNull();
    expect(c.querySelector("pre code")?.textContent).toContain("k\n\nl");
    expect(c.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("only typesets what a delta adds", () => {
    const spy = vi.spyOn(katex, "renderToString");
    const { rerender, container } = render(<MathText text={"$a$\n\n$b$ and"} />);
    expect(spy).toHaveBeenCalledTimes(2);
    rerender(<MathText text={"$a$\n\n$b$ and more"} />);
    expect(spy).toHaveBeenCalledTimes(2);
    rerender(<MathText text={"$a$\n\n$b$ and more $c$"} />);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(formulas(container)).toEqual(["a", "b", "c"]);
    spy.mockRestore();
  });
});

describe("MathText safety", () => {
  it.each(["<script>window.pwned = 1</script>", "<img src=x onerror=\"window.pwned = 1\">", "a <b onclick=\"x()\">b</b>"])("shows raw HTML as inert text: %s", (html) => {
    for (const c of [block(html), math(html)]) {
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
    expect(math("![a diagram](https://evil.example/x.png)").querySelector("img")).toBeNull();
  });
});

describe("MathText robustness", () => {
  it("shows invalid LaTeX as its source, keeping the rest of the message", () => {
    const c = block("Before $\\frac{1}{$ and $\\notacommand{x}$ after");
    expect(c.textContent).toContain("Before");
    expect(c.textContent).toContain("\\notacommand{x}");
    expect(c.textContent).toContain("after");
  });

  it("survives every prefix of a reply in one mounted component, and recovers at the end", () => {
    const reply = "# Title\n\n**bold** $x^2$ and\n\n$$\n\\frac{a}{b}\n$$\n\n| a | $b$ |\n|---|---|\n| `1` | [l](https://e.com) |\n\n```js\nlet a\n```\n\ncosts $5 and $10\n";
    const { container, rerender } = render(<MathText text="" />);
    for (let i = 1; i <= reply.length; i++) rerender(<MathText text={reply.slice(0, i)} />);
    expect(formulas(container)).toEqual(["x^2", "\\frac{a}{b}", "b"]);
    expect(container.querySelector("h4")?.textContent).toBe("Title");
    expect(container.querySelector("pre code")?.textContent).toBe("let a\n");
    expect(container.querySelector("td a")?.textContent).toBe("l");
    expect(container.lastElementChild?.lastElementChild?.textContent).toBe("costs $5 and $10");
  }, 30_000);

  it("turns half-written maths into a formula when it closes, and back", () => {
    const { container, rerender } = render(<MathText text="so $x" />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("so $x");
    rerender(<MathText text="so $x$" />);
    expect(formulas(container)).toEqual(["x"]);
    rerender(<MathText text="so $x$5" />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("so $x$5");
  });

  // Each of these takes from seconds to minutes in the parser or the DOM, or overflows the stack, if it gets that far.
  it.each([
    ["blockquotes", ">".repeat(2000) + " deep"],
    ["bullet lists", "- ".repeat(2000) + "deep"],
    ["ordered lists", "1. ".repeat(2000) + "deep"],
    ["emphasis", "*".repeat(5000) + "deep" + "*".repeat(5000)],
    ["links", "[".repeat(5000) + "deep" + "](u)".repeat(5000)],
  ])("shows hostile nested %s as plain text, keeping the rest of the reply", (_name, hostile) => {
    const c = block(`**before**\n\n${hostile}\n\n**after**`);
    expect([...c.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(["before", "after"]);
    expect(c.querySelector("blockquote, ul, ol, em, a")).toBeNull();
    expect(c.querySelector("p.math-text-literal")?.textContent?.trim()).toBe(hostile.trim());
  });

  it("shows hostile indentation as plain text", () => {
    const hostile = " ".repeat(300) + "- deep";
    expect(block(hostile).querySelector("p.math-text-literal")?.textContent).toBe(hostile);
  });

  it("still renders ordinary nesting", () => {
    expect(block(">".repeat(32) + " deep").querySelectorAll("blockquote")).toHaveLength(32);
    expect(block("- ".repeat(32) + "deep").querySelectorAll("ul")).toHaveLength(32);
  });

  it("shows a macro bomb as its source", () => {
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
