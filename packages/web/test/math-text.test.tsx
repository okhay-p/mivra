import { render } from "@testing-library/react";
import katex from "katex";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MathText } from "../src/MathText.js";
import { isTooDeep, replyBlocks, separateDisplayFences, splitBlocks } from "../src/math-syntax.js";

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

describe("MathText display fences that share a line with text", () => {
  const formula = String.raw`|A\cup B\cup C|=|A|+|B|+|C| -|A\cap B|-|A\cap C|-|B\cap C| +|A\cap B\cap C|.`;
  const paragraphs = (c: Element) => [...c.querySelectorAll("p")].map((p) => p.textContent?.trim());

  // The four layouts from issue #30.
  it.each([
    ["the closing `$$` followed by text", `That gives the formula:\n$$\n${formula}$$ The pairwise overlaps.`],
    ["a one-line `$$...$$` after a newline", `That gives the formula:\n$$${formula}$$\nThe pairwise overlaps.`],
    ["`$$...$$` inline in a sentence", `That gives the formula: $$${formula}$$ The pairwise overlaps.`],
    ["each `$$` on its own line", `That gives the formula:\n$$\n${formula}\n$$\nThe pairwise overlaps.`],
  ])("renders %s as display maths followed by the text", (_name, text) => {
    const c = block(text);
    expect(c.querySelector(".katex-error")).toBeNull();
    expect(c.querySelector(".katex-display")).not.toBeNull();
    expect(formulas(c)).toEqual([formula]);
    expect(c.textContent).toContain("That gives the formula:");
    expect(c.textContent).toContain("The pairwise overlaps.");
    expect(c.textContent).not.toContain("$");
  });

  it("puts the text after the closing `$$` in its own paragraph", () => {
    const c = block(`Intro:\n$$\n${formula}$$ The pairwise overlaps.`);
    expect(paragraphs(c)).toEqual(["Intro:", "The pairwise overlaps."]);
  });

  it("closes the block at a `$$` that ends a line of the formula", () => {
    const c = block("$$\na +\nb$$\n\nafter");
    expect(formulas(c)).toEqual(["a +\nb"]);
    expect(paragraphs(c)).toEqual(["after"]);
  });

  it("keeps the text on the opening `$$` line, which the parser would drop", () => {
    const c = block("$$ x + y\n= z\n$$ and so on");
    expect(formulas(c)).toEqual(["x + y\n= z"]);
    expect(paragraphs(c)).toEqual(["and so on"]);
  });

  it("keeps the formula's own indented lines", () => {
    const c = block("$$\n\\begin{aligned}\n  a &= b\n  c &= d\n\\end{aligned}$$ So both hold.");
    expect(formulas(c)).toEqual(["\\begin{aligned}\n  a &= b\n  c &= d\n\\end{aligned}"]);
    expect(paragraphs(c)).toEqual(["So both hold."]);
  });

  it("leaves a display block in a list item as written", () => {
    const text = "- a\n  $$\n  x$$ tail\n- b";
    expect(separateDisplayFences(text)).toBe(text);
    expect(block(text).querySelectorAll("ul > li")).toHaveLength(2);
  });

  it("leaves `$$` in code alone", () => {
    const fenced = "```\n$$\nx$$ y\n```";
    expect(separateDisplayFences(fenced)).toBe(fenced);
    expect(block(fenced).querySelector("pre code")?.textContent).toBe("$$\nx$$ y\n");
    const span = "`$$`\n\nx$$ y";
    expect(separateDisplayFences(span)).toBe(span);
  });

  it.each([
    ["an escaped dollar", String.raw`$$` + "\n" + String.raw`a \$$ b` + "\n$$"],
    ["a shorter run in a `$$$` block", "$$$\na $$ b\n$$$"],
    ["text with raw HTML", "<div>\n$$\nx$$ y"],
    ["a closed block", "$$\nx\n$$\ny $$ z"],
    ["a one-line formula", "$$x$$ y\n\nz $$ w"],
  ])("doesn't move anything for %s", (_name, text) => {
    expect(separateDisplayFences(text)).toBe(text);
  });

  it("closes at a `$$` after an escaped backslash, and keeps line endings", () => {
    expect(separateDisplayFences("$$\r\na \\\\$$ b\r\n")).toBe("$$\r\na \\\\\r\n$$\r\nb\r\n");
  });

  it("renders every prefix of the reply without swallowing what follows", () => {
    const reply = `Intro:\n$$\n${formula}$$ The pairwise overlaps.\n\nNext.`;
    const { container, rerender } = render(<MathText text="" />);
    for (let i = 1; i <= reply.length; i += 7) rerender(<MathText text={reply.slice(0, i)} />);
    rerender(<MathText text={reply} />);
    expect(formulas(container)).toEqual([formula]);
    expect(paragraphs(container)).toEqual(["Intro:", "The pairwise overlaps.", "Next."]);
  });

  it("shows a block too long to parse as the reply wrote it, without the escapes added to separate it", () => {
    const text = `$$\n${"x".repeat(50_001)}$$ - tail`;
    const c = block(text);
    expect(c.querySelector(".katex")).toBeNull();
    expect(c.textContent).toBe(text);
  });

  it("splits the separated text the same as a single parse", () => {
    const text = `one\n\n$$\n${formula}$$ two\n\nthree`;
    expect(splitBlocks(separateDisplayFences(text)).length).toBeGreaterThan(1);
    const normal = (html: string) => html.replace(/<\/?div[^>]*>|\s+/g, "");
    expect(normal(block(text).innerHTML)).toBe(normal(block(`[unused]: https://e.com\n\n${text}`).innerHTML));
  });
});

describe("MathText display fences in lists and quotes", () => {
  const normal = (html: string) => html.replace(/<\/?div[^>]*>|\s+/g, "");
  const codes = (c: Element) => [...c.querySelectorAll("pre code")].map((code) => code.textContent);

  // Each case is checked through the real pipeline: the code blocks and formulas it should produce, and the same
  // HTML as a single parse, so the splitter agrees with the parser on the normalised text. Only a display block at
  // the top level is separated: one in a list item or a quote is left as written (`unchanged`), and so keeps the
  // KaTeX error it had (`error`), as telling its lines from code there needs the parser's container rules.
  it.each<[string, string, { code?: string[]; math?: string[]; text?: string[]; unchanged?: boolean; error?: boolean; startOnly?: boolean }]>([
    ["a fence opened on a list marker", "- ```\n  $$\n  x$$ tail\n  ```", { code: ["$$\nx$$ tail\n"], unchanged: true }],
    ["a fence in a quote", "> ```\n> $$\n> x$$ tail\n> ```", { code: ["$$\nx$$ tail\n"], unchanged: true }],
    ["a fence in a quote in a list item", "- > ```\n  > $$\n  > x$$ tail\n  > ```", { code: ["$$\nx$$ tail\n"], unchanged: true }],
    ["indented code in a list item", "- a\n\n      $$\n      x$$ y", { code: ["$$\nx$$ y\n"], unchanged: true }],
    ["a formula the next list item ends", "- a\n  $$\n  x\n- b\n\ntext $$ tail", { math: ["x"], text: ["text $$ tail"], unchanged: true }],
    ["a formula a dedent ends", "- a\n  $$\n  x\n\ntext $$ tail", { math: ["x"], text: ["text $$ tail"], unchanged: true }],
    ["a formula the end of a quote ends", "> $$\n> x\n\ntext $$ tail", { math: ["x"], text: ["text $$ tail"], unchanged: true }],
    ["a formula in a nested list item", "- parent\n  - child\n    $$\n    x$$ tail", { unchanged: true, error: true }],
    // Sol's redesign review: only spaces and tabs close a fence; a BOM hides a first-line fence from the scan;
    // dollars inside TeX that takes literal text belong to the formula.
    ["a fence a non-breaking space doesn't close", "```\n```\u00a0\n$$\nx$$ tail\n```", { code: ["```\u00a0\n$$\nx$$ tail\n"], unchanged: true }],
    ["a fence a form feed doesn't close", "```\n```\f\n$$\nx$$ tail\n```", { code: ["```\f\n$$\nx$$ tail\n"], unchanged: true }],
    // A byte order mark only counts at the very start, so this one isn't compared with text put before it.
    ["a fence after a byte order mark", "\uFEFF```\n$$\nx$$ tail\n```", { code: ["$$\nx$$ tail\n"], unchanged: true, startOnly: true }],
    ["dollars in \\verb", "$$\n\\verb|$$|\n$$", { math: ["\\verb|$$|"], unchanged: true }],
    ["dollars in \\text", "$$\n\\text{a$$ b}\n$$", { math: ["\\text{a$$ b}"], unchanged: true }],
    ["dollars in an \\href URL", "$$\n\\href{https://e.com/?q=$$}{x}\n$$", { math: ["\\href{https://e.com/?q=$$}{x}"], unchanged: true }],
    ["a closing `$$` after a closed \\text", "$$\n\\text{a} x$$ tail", { math: ["\\text{a} x"], text: ["tail"] }],
    // Round 2 of the redesign: TeX arguments that span lines, and comments, keep their dollars.
    ["dollars in a \\text across lines", "$$\n\\text{a\n b$$ c}\n$$", { math: ["\\text{a\n b$$ c}"], unchanged: true }],
    ["dollars in a nested \\texttt across lines", "$$\nx + \\textbf{\\texttt{a\nb$$ c}}\n$$", { unchanged: true, error: true }],
    ["dollars in an \\href URL across lines", "$$\n\\href{https://e.com/\n?q=$$}{x}\n$$", { math: ["\\href{https://e.com/\n?q=$$}{x}"], unchanged: true }],
    ["dollars in a comment", "$$\nx % $$ hidden comment\n$$", { math: ["x % $$ hidden comment"], unchanged: true }],
    ["dollars after a comment on an earlier line", "$$\nx % note\ny$$ tail", { unchanged: true, error: true }],
    ["a closing `$$` after an escaped percent", "$$\n50\\% x$$ tail", { math: ["50\\% x"], text: ["tail"] }],
    // Round 3: a macro defined in the formula can take its argument up to any text, dollars included.
    ["dollars in a \\def macro's argument", "$$\n\\def\\foo#1!{\\text{#1}}\\foo a$$ b!\n$$", { math: ["\\def\\foo#1!{\\text{#1}}\\foo a$$ b!"], unchanged: true }],
    ["dollars after a \\newcommand", "$$\n\\newcommand{\\x}{1} x$$ tail", { unchanged: true, error: true }],
    ["a formula in a quote", "> $$\n> x$$ tail", { unchanged: true, error: true }],
    ["a formula on a list marker line", "- $$ x + y\n  = z\n  $$ after", { unchanged: true, error: true }],
    ["a formula in an ordered item", "1. $$\n   x$$ tail\n2. b", { text: ["b"], unchanged: true, error: true }],
    ["a formula after a lazy line", "- a\nb\n  $$\n  x$$ tail", { unchanged: true, error: true }],
    ["a formula in a quote in a list item", "- > $$\n  > x$$ tail", { unchanged: true, error: true }],
    ["a formula a blank line ends in a quote", "> $$\n> x\n\n> y$$ z", { math: ["x"], text: ["y$$ z"], unchanged: true }],
    ["a formula after a blank line in a list item in a quote", "> - a\n>\n>   $$\n>   x$$ tail", { unchanged: true, error: true }],
    // An indented `$$` could open a block at the top level or in a list item, so nothing after it is touched.
    ["a formula after indented code", "    $$\n    x\n$$\ny$$ tail", { code: ["$$\nx\n"], unchanged: true, error: true }],
    // Here the indented `$$` is top level, so the column-0 one closes it and `y$$ tail` is a paragraph.
    ["a formula after an indented `$$`", "a\n  $$\nx\n\n$$\ny$$ tail", { math: ["x"], text: ["y$$ tail"], unchanged: true }],
    ["a list marker after the closing `$$`", "$$\nx$$ 1. next", { math: ["x"], text: ["1. next"] }],
    ["a `$$` after the closing `$$`", "$$\nx$$ $$ y", { math: ["x"], text: ["$$ y"] }],
    ["a quote marker after the closing `$$`", "$$\nx$$ > y", { math: ["x"], text: ["> y"] }],
    ["a quote marker after the closing `$$` in a list item", "- $$\n  x$$ > y", { unchanged: true, error: true }],
    ["a fence closed in a list item", "- ```\n  a\n  ```\n  $$\n  x$$ tail", { code: ["a\n"], unchanged: true, error: true }],
    // A block at column 0 is top level whatever comes before it, as it can't continue a list item lazily.
    ["a formula after a list item", "- a\n$$\nx$$ tail", { math: ["x"], text: ["a", "tail"] }],
    ["a formula after a quote", "> a\n$$\nx$$ tail", { math: ["x"], text: ["a", "tail"] }],
    ["a formula after a table", "| a |\n|---|\n$$\nx$$ tail", { math: ["x"], text: ["tail"] }],
    ["a formula after a fence in a list item", "- ```\n$$\nx$$ tail", { code: [""], math: ["x"], text: ["tail"] }],
    ["a formula after a formula in a quote", "> $$\n> x\n$$\ny$$ tail", { math: ["x", "y"], text: ["tail"] }],
    // The parser ends the empty item at the blank line, and then reads each line as its own indented code.
    ["indented code after an empty item", "-\n\n    $$\n    x$$ tail", { code: ["$$\n", "x$$ tail\n"], unchanged: true }],
    ["a fence in an item after a setext heading", "- a\n  ===\n  2. ```\n     $$\n     x$$ tail\n     ```", { code: ["$$\nx$$ tail\n"], unchanged: true }],
    ["a fence in an item after a `-` underline", "- a\n  -\n  2. ```\n     $$\n     x$$ tail\n     ```", { code: ["$$\nx$$ tail\n"], unchanged: true }],
    ["a fence in an item after indented code in a quote", ">\n    a\n2. ```\n   $$\n   x$$ tail\n   ```", { code: ["a\n", "$$\nx$$ tail\n"], unchanged: true }],
    ["a fence in an item after a table with an escaped backslash", "- a\\\\|b\n  |---|---|\n  2. ```\n     $$\n     x$$ tail\n     ```", { code: ["$$\nx$$ tail\n"], unchanged: true }],
    ["a numbered line after indented code", "    a\n\n2. ```\n   $$\n   x$$ tail", { code: ["a\n"], unchanged: true, error: true }],
    ["a numbered line after a quote and a blank line of spaces", "> a\n     \nb\n10. $$ x\ny tail", { text: ["y tail"], unchanged: true }],
    ["a line after a table in a list item", "* a\n  |---|\nb\n1)\n      $$ x", { text: ["$$ x"], unchanged: true }],
    ["a numbered line in a quote after indented code", "    a\n\n> 2. $$ x", { code: ["a\n"], text: ["2. $$ x"], unchanged: true }],
    ["a numbered line in a list item after a paragraph", "a\n- 2. $$ x", { text: ["2. $$ x"], unchanged: true }],
    ["a numbered line after a row indented past a table's", "a\n     ---|\n2. $$ x", { text: ["2. $$ x"], unchanged: true }],
    ["a formula in a quote after an empty item", ">-\n  > $$\n  > x$$ tail", { unchanged: true, error: true }],
    ["a definition after the closing `$$`", "$$\nx$$ [a]: https://example.com", { math: ["x"], text: ["[a]: https://example.com"] }],
    ["a definition label left open after the closing `$$`", "$$\nx$$ [a\n]: https://example.com", { math: ["x"], text: ["]: https://example.com"] }],
    ["an HTML tag after the closing `$$`", "$$\nx$$ <div>\n$$\ny\n$$", { math: ["x", "y"], text: ["<div>"] }],
    ["an autolink after the closing `$$`", "$$\nx$$ <https://example.com>", { math: ["x"], text: ["https://example.com"] }],
    ["a fence after the closing `$$`", "$$\nx$$ ```\n$$\ny$$ tail", { math: ["x", "y"], text: ["```", "tail"] }],
    ["a top-level fence holding a display block", "```\n$$\nx$$ tail\n```\n$$\ny$$ tail", { code: ["$$\nx$$ tail\n"], math: ["y"], text: ["tail"] }],
  ])("normalises %s as the parser reads it", (_name, text, want) => {
    const normalised = separateDisplayFences(text);
    if (want.unchanged) expect(normalised).toBe(text);
    else expect(normalised).not.toBe(text);
    expect(separateDisplayFences(normalised)).toBe(normalised);
    const c = block(text);
    expect(c.querySelector(".katex-error") !== null).toBe(want.error ?? false);
    expect(codes(c)).toEqual(want.code ?? []);
    expect(formulas(c)).toEqual(want.math ?? []);
    for (const t of want.text ?? []) expect([...c.querySelectorAll("p, li")].some((p) => p.textContent?.trim().endsWith(t))).toBe(true);
    if (want.startOnly) return;
    expect(normal(c.innerHTML)).toBe(normal(block(`[unused]: https://e.com\n\n${text}`).innerHTML));
    const prose = `one\n\n${text}\n\nlast`;
    expect(normal(block(prose).innerHTML)).toBe(normal(block(`[unused]: https://e.com\n\n${prose}`).innerHTML));
  });
});

describe("separating display fences in a long block", () => {
  // Sol, round 3: re-reading the whole block at every candidate `$$` took over 9 s on the main thread.
  it("reads each line once, however many dollar runs the block holds", () => {
    const text = "$$\n\\text{\n" + "a$$\n".repeat(8000) + "}\n$$";
    const started = performance.now();
    expect(separateDisplayFences(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(1000);
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

  it("keeps each block's source as the reply wrote it", () => {
    expect(replyBlocks("one\n\n$$\nx$$ - two\n\nthree")).toEqual([
      { text: "one\n\n", source: "one\n\n" },
      { text: "$$\nx\n$$\n\\- two\n\n", source: "$$\nx$$ - two\n\n" },
      { text: "three", source: "three" },
    ]);
    expect(replyBlocks("")).toEqual([{ text: "", source: "" }]);
  });

  it("doesn't split before a list marker the parser reads as text after indented code", () => {
    expect(splitBlocks("    a\n\n2. b")).toEqual(["    a\n\n2. b"]);
    expect(splitBlocks("    a\n\n> - b")).toEqual(["    a\n\n> - b"]);
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

  // Inherently slow: this is one real render per character, and it's the only test that walks every prefix.
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

const nested = "[".repeat(40) + "x" + "](u)".repeat(40);
const bare = "[".repeat(40) + "x" + "]".repeat(40);

describe("MathText guard on ordinary content", () => {
  // These need more formulas than the guard's limit, and each real one costs jsdom over 10ms to parse. They're
  // about which formulas reach KaTeX, so all they need back is the source; the tests above cover KaTeX's output.
  beforeEach(() => {
    vi.spyOn(katex, "renderToString").mockImplementation((source) => `<span class="katex"><annotation>${source.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</annotation></span>`);
  });

  const rows = Array.from({ length: 33 }, (_, i) => `| $[${i},${i + 1})$ | ${i} |`).join("\n");

  it("renders a table of half-open intervals", () => {
    const c = block(`| interval | n |\n|---|---|\n${rows}`);
    expect(c.querySelectorAll("tbody tr")).toHaveLength(33);
    expect(formulas(c)[0]).toBe("[0,1)");
    expect(c.querySelector(".math-text-literal")).toBeNull();
  });

  it("renders every formula in a paragraph with an inequality and closed intervals", () => {
    const c = block("$a<b$ " + "$[0,1]$ ".repeat(66));
    expect(formulas(c)).toHaveLength(67);
    expect(c.querySelector(".math-text-literal")).toBeNull();
  });

  it("renders a table of inequalities and closed intervals", () => {
    const body = Array.from({ length: 66 }, (_, i) => `| $a_{${i}}<b$ | $[${i},${i + 1}]$ |`).join("\n");
    const c = block(`| a | b |\n|---|---|\n${body}`);
    expect(c.querySelectorAll("tbody tr")).toHaveLength(66);
    expect(formulas(c)).toHaveLength(132);
  });

  it("renders inline code with brackets after a `<`", () => {
    const c = block("When a < b, see " + "`x[0]` ".repeat(66));
    expect(c.querySelectorAll("code")).toHaveLength(66);
    expect(c.querySelector("code")?.textContent).toBe("x[0]");
  });

  it("renders half-open intervals of both kinds in one paragraph", () => {
    const c = block("$[a,b)$ ".repeat(33) + "$(a,b]$ ".repeat(33));
    expect(formulas(c)).toHaveLength(66);
  });

  it.each([
    ["closed intervals", Array.from({ length: 80 }, (_, i) => `| $[${i},${i + 1}]$ | $[${i},${i}]$ |`).join("\n")],
    ["half-open intervals without dollars", Array.from({ length: 80 }, (_, i) => `| [${i},${i + 1}) | ${i} |`).join("\n")],
    ["both kinds of half-open interval", Array.from({ length: 80 }, (_, i) => `| $(${i},${i + 1}]$ | $[${i},${i + 1})$ |`).join("\n")],
  ])("renders a table of %s", (_name, body) => {
    const c = block(`| a | b |\n|---|---|\n${body}`);
    expect(c.querySelectorAll("tbody tr")).toHaveLength(80);
    expect(c.querySelector(".math-text-literal")).toBeNull();
  });

  it.each([
    ["underscores in a string", `const s = "${"_".repeat(33)}";`],
    ["stars and tildes", `${"*".repeat(40)} ${"~".repeat(40)}x${"*".repeat(40)}`],
    ["deep indentation", `${" ".repeat(300)}x`],
    ["list-like lines", "- ".repeat(40) + "x"],
    ["brackets", nested],
  ])("keeps code containing %s as code", (_name, code) => {
    const c = block(`Here:\n\n\`\`\`js\n${code}\n\`\`\`\n`);
    expect(c.querySelector("pre code")?.textContent).toBe(`${code}\n`);
    expect(c.querySelector(".math-text-literal")).toBeNull();
  });

  it.each(["```", "~~~~"])("keeps code that follows a sentence directly, fenced by %s", (fence) => {
    const code = `s = "${"_".repeat(33)}"`;
    const c = block(`Example:\n${fence}\n${code}\n${fence}`);
    expect(c.querySelector("pre code")?.textContent).toBe(`${code}\n`);
  });

  it("keeps a code span's delimiter runs from nesting with anything", () => {
    const blank = "_".repeat(40);
    const c = block(`Compare \`${blank}\` with \`${blank}\` here`);
    expect([...c.querySelectorAll("code")].map((e) => e.textContent)).toEqual([blank, blank]);
  });

  it.each([
    ["a thematic break", "_".repeat(40)],
    ["blanks to fill in", `Name: ${"_".repeat(40)} Date: ${"_".repeat(40)}`],
    ["a blank run on to a label", `Name:${"_".repeat(40)} Date:${"_".repeat(40)}`],
    ["many flat links", Array.from({ length: 40 }, (_, i) => `- [link ${i}](https://e.com/${i})`).join("\n")],
    ["many bold terms", Array.from({ length: 40 }, (_, i) => `- **term ${i}**: $x_${i}$`).join("\n")],
  ])("doesn't take %s for nesting", (_name, text) => {
    expect(isTooDeep(text)).toBe(false);
  });

  it("keeps the code box when a block is too long to parse", () => {
    const code = `${"x".repeat(60_000)}\n`;
    for (const text of [`\`\`\`\n${code}\`\`\``, `\`\`\`\n${code}`, `Example:\n\`\`\`\n${code}\`\`\`\nThat's it.`]) {
      const c = block(text);
      expect(c.querySelector("pre code")?.textContent).toBe(code);
    }
    const mixed = block(`Example:\n\`\`\`\n${code}\`\`\`\nThat's it.`);
    expect(mixed.textContent).toContain("Example:");
    expect(mixed.textContent).toContain("That's it.");
  });

  it("keeps the code box when the text around it is hostile", () => {
    const c = block(`See ${nested}\n\`\`\`\ncode\n\`\`\``);
    expect(c.querySelector("pre code")?.textContent).toBe("code\n");
    expect(c.querySelector(".math-text-literal")?.textContent).toContain(nested);
    expect(c.querySelector("a")).toBeNull();
  });
});

describe("MathText guard on hostile content", () => {
  const hostile = [">".repeat(40) + " x", "- ".repeat(40) + "x", " ".repeat(300) + "x", nested];

  it.each(hostile)("doesn't let code excuse what follows a closed fence: %s", (text) => {
    expect(isTooDeep(`\`\`\`\ncode\n\`\`\`\n${text}`)).toBe(true);
    expect(isTooDeep(`$$\nx\n$$\n${text}`)).toBe(true);
  });

  it.each([
    ["a list item", "- a\n  ```\nb\n\n"],
    ["a blockquote's list item", "> - a\n  ```\n\n"],
    ["indented code", "    ```\n\n"],
    ["a one-line `$$` formula", "$$x$$\n"],
    ["a closed fence", "```\nx\n```\n"],
    ["a lone carriage return", "~~~\r~~~\r"],
  ])("isn't fooled by %s", (_name, prefix) => {
    for (const text of hostile) expect(isTooDeep(prefix + text)).toBe(true);
  });

  it.each(["`", "$"])("counts a bracket run after an unterminated %s", (prefix) => {
    expect(isTooDeep(prefix + nested)).toBe(true);
  });

  // The parser reads each of these fences as something else, so what follows is live.
  it.each([
    ["a definition's destination", "[a]:\n```\n"],
    ["a definition's title", '[a]: u "\n```\n"\n'],
    ["a multiline label", "[a\n```\n]: u\n"],
    ["an HTML block", "<div>\n```\n\n"],
    ["an HTML comment", "<!--\n```\n-->\n"],
  ])("doesn't exempt the fence in %s", (_name, prefix) => {
    for (const text of hostile) expect(isTooDeep(prefix + text)).toBe(true);
  });

  it.each(["[a ".repeat(5000) + "x" + "](u)".repeat(5000), "]".repeat(49_000), "[a](u) ".repeat(3000), "*a ".repeat(8000)])("leaves what has no long literal run to the parser: %#", (text) => {
    expect(isTooDeep(text)).toBe(false);
  });

  it.each([
    ["an unterminated fence", "```\n"],
    ["an unterminated tilde fence", "~~~\n"],
    ["an unterminated `$$`", "$$\n"],
  ])("leaves what's really inside %s to the parser, which won't read it", (_name, prefix) => {
    const text = prefix + ">".repeat(2000) + " deep";
    expect(isTooDeep(text)).toBe(false);
    // A parser that did read it would produce a blockquote, and that nesting is what's slow.
    expect(block(text).querySelector("blockquote")).toBeNull();
  });
});

describe("MathText empty formulas", () => {
  it.each(["$$\n$$", "$$\n\n$$", "```math\n```", "$$", "$$\n", "$$\n\n", "```math", "```math\n"])("doesn't invent a formula for %j", (text) => {
    const c = block(text);
    expect(c.textContent).not.toContain("undefined");
    expect(formulas(c).join("")).not.toContain("undefined");
  });

  it.each(["$$ $$", "a $$ $$ b", "$$  $$", "a $$\n$$ b"])("doesn't invent an inline formula for %j", (text) => {
    expect(block(text).textContent).not.toContain("undefined");
  });

  it("doesn't invent a formula at any prefix of a `$$` block", () => {
    const reply = "$$\nx\n$$\n\n```math\ny\n```";
    const { container, rerender } = render(<MathText text="" />);
    for (let i = 1; i <= reply.length; i++) {
      rerender(<MathText text={reply.slice(0, i)} />);
      expect(container.textContent).not.toContain("undefined");
    }
    expect(formulas(container)).toEqual(["x", "y"]);
  });
});

describe("MathText split against a single parse", () => {
  // A definition keeps a reply in one piece, so this is what the text renders as with no splitting at all.
  const singleParse = (text: string) => block(`[unused]: https://e.com\n\n${text}`).innerHTML;
  const normal = (html: string) => html.replace(/<\/?div[^>]*>|\s+/g, "");

  it.each([
    ["paragraphs and code", "one\n\n```\na\n\nb\n```\n\ntwo\n\n$x$"],
    ["a three-dollar formula", "one\n\n$$$\na\n\nb\n$$$\n\ntwo"],
    ["a three-dollar formula with a `$$` line in it", "one\n\n$$$\na\n$$\n\nb\n$$$\n\ntwo"],
    ["a four-dollar close on a two-dollar open", "one\n\n$$\na\n\nb\n$$$$\n\ntwo"],
    ["a long fence with a short one inside", "one\n\n````\n```\n\nb\n````\n\ntwo"],
    ["a loose list", "one\n\n- a\n\n- b\n\n  c\n\ntwo"],
    ["a fence in a list that the list ends", "one\n\n- a\n  ```\n  b\n\n```\nc\n\nd\n```\n\ntwo"],
    ["a closed fence in a list item", "one\n\n- ```\n  a\n  ```\n\n```\nb\n\nc\n```\n\ntwo"],
    ["a fence after a list that a heading ended", "one\n\n- a\n# h\n  ```\n---\n\nb\n```\n\ntwo"],
    ["CRLF line endings", "one\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\ntwo"],
    ["a table and a quote", "one\n\n| a |\n|---|\n| $b$ |\n\n> c\n\n> d\n\ntwo"],
  ])("splits %s without changing it", (_name, text) => {
    const blocks = splitBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join("")).toBe(text);
    expect(normal(block(text).innerHTML)).toBe(normal(singleParse(text)));
  });

  it("keeps a `$$$` block as one display formula", () => {
    const text = "one\n\n$$$\na\n\nb\n$$$\n\ntwo";
    expect(splitBlocks(text)).toEqual(["one\n\n", "$$$\na\n\nb\n$$$\n\n", "two"]);
    const c = block(text);
    expect(c.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(formulas(c)).toEqual(["a\n\nb"]);
  });

  it.each([
    ["a multiline label", "[a][r]\n\n[r\n]: https://example.com"],
    ["a label starting on its own line", "[a][r]\n\n[\nr\n]: https://example.com"],
    ["a label with an escaped bracket", "[a][r\\]s]\n\n[r\\]s]: https://example.com"],
    ["a definition in a quote", "[a][r]\n\n> [r\n> ]: https://example.com"],
    ["a definition in a list item", "[a][r]\n\n- [r]: https://example.com"],
    ["a destination on the next line", "[a][r]\n\n[r]:\n  https://example.com"],
  ])("resolves a reference to a definition with %s", (_name, text) => {
    expect(splitBlocks(text)).toEqual([text]);
    expect(block(text).querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
  });

  it.each(["<!-- a\n\n**b** -->", "<pre>\n\n**b**\n</pre>", "<script>\n\n**b**\n</script>", "<?x\n\n**b**\n?>"])("keeps %j, which runs across a blank line, as text", (text) => {
    expect(splitBlocks(text)).toEqual([text]);
    expect(block(text).querySelector("strong")).toBeNull();
  });

  it("doesn't take a fence hidden in an HTML block for a real one", () => {
    const text = "<div>\n$$$\n\n$$$\n- x\n\ny";
    expect(splitBlocks(text)).toEqual([text]);
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
    rerender(<Mocked text={"boom\n```\ncode\n```"} />);
    expect(container.querySelector("pre code")?.textContent).toBe("code\n");
    expect(container.querySelector("p.math-text-literal")?.textContent).toBe("boom\n");
    vi.doUnmock("react-markdown");
  });
});
