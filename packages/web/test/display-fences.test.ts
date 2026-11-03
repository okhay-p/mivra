import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { fenceLines, remarkDollarRule, replyBlocks, separateDisplayFences } from "../src/math-syntax.js";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { line: number }; end: { line: number } };
}

const plugins = [remarkGfm, remarkMath, remarkDollarRule];

/** The parser's tree for `text`, as MathText's plugins parse it. */
function parse(text: string): MdNode {
  let tree: MdNode | undefined;
  const capture = () => (root: MdNode) => {
    tree = root;
  };
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [...plugins, capture] as never }, text));
  return tree!;
}

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: plugins as never }, text)).replace(/\s+/g, "");

function* nodes(node: MdNode): Generator<MdNode> {
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}

const VISIBLE = ["text", "inlineCode", "code", "html", "math", "inlineMath"];

/** The words that show nowhere, such as those in a definition. */
function hiddenWords(text: string): Set<string> {
  const shown = new Set<string>();
  for (const node of nodes(parse(text))) if (VISIBLE.includes(node.type)) for (const word of node.value!.match(/w\d+/g) ?? []) shown.add(word);
  return new Set((text.match(/w\d+/g) ?? []).filter((word) => !shown.has(word)));
}

/**
 * What's wrong with how `text` is normalised. Each line the normaliser rewrites must be one the parser puts in a
 * display block, given the rewrites before it, so it never touches code, a paragraph or anything else. Afterwards
 * no word may be hidden that showed before, the result must normalise to itself, and its blocks must render the
 * same as the whole.
 */
function problems(text: string): string[] {
  let edited: string[];
  try {
    edited = fenceLines(text);
  } catch (error) {
    return [String(error)];
  }
  const original = text.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) ?? [];
  const found: string[] = [];
  const current = [...original];
  const moved = new Set<string>();
  for (const [i, line] of edited.entries()) {
    if (line === original[i]) continue;
    const at = current.slice(0, i).join("").split(/\r\n?|\n/).length;
    const inMath = [...nodes(parse(current.join("")))].some((node) => node.type === "math" && node.position!.start.line <= at && at <= node.position!.end.line);
    if (!inMath) found.push(`rewrote line ${at}, which isn't in a display block`);
    current[i] = line;
    for (const word of line.match(/w\d+/g) ?? []) moved.add(word);
  }
  const normalised = edited.join("");
  if (normalised === text) return found;
  if (separateDisplayFences(normalised) !== normalised) found.push("not idempotent");
  // A line it didn't touch can turn into anything once a block closes earlier, as the reply meant it to.
  const hidden = [...hiddenWords(normalised)].filter((word) => moved.has(word));
  if (hidden.length) found.push(`hid ${hidden.join(" ")}`);
  const blocks = replyBlocks(text);
  if (blocks.map((block) => block.source).join("") !== text) found.push("block sources don't make up the reply");
  if (blocks.map((block) => html(block.text)).join("") !== html(normalised)) found.push("blocks render differently from the whole");
  return found;
}

// A tiny seeded generator (mulberry32), so every run checks the same replies.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIXES = ["", "", "", "- ", "-", "* ", "1. ", "2. ", "1)", "10. ", "> ", ">", "  ", "   ", "    ", "     ", "      ", "> - ", "- > ", "  - ", "  > ", ">  ", "1. - "];
// `W` becomes a fresh word, so a missing word shows exactly what was lost.
const CONTENTS = ["", "", "W", "W W", "$$", "$$", "$$ W", "W$$ W", "W$$", "$$W$$ W", "```", "~~~", "===", "---", "-", "***", "# W", "[W]: W", "W$$ [W]: W", "W$$ - W", "W$$ # W", "W$$ > W", "W$$ <div>W", "W$$ 1. W", "W$$ ```", "W$$ ===", "W$$ ---", "W$$ | W |", "|---|", "W $$ W", "\\$$ W", "$$$", "W$$$ W", "W$$ W$$ W", "    W$$ W", "W $$ W $$", "| W | W |", "|---|---|", "---|", "W | W"];

function generate(next: () => number): string {
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)]!;
  let word = 0;
  const lines = Array.from({ length: 1 + Math.floor(next() * 7) }, () => pick(PREFIXES) + pick(CONTENTS));
  return lines.join(next() < 0.1 ? "\r\n" : "\n").replace(/W/g, () => `w${word++}`);
}

// A few hundred replies keep this near two seconds. To search further, run it with FUZZ_SEED and FUZZ_RUNS set,
// say FUZZ_RUNS=15000 and a raised --testTimeout.
describe("separateDisplayFences against the parser", () => {
  it("only rewrites display blocks, over seeded random replies", () => {
    const next = random(Number(process.env.FUZZ_SEED ?? 30));
    const failures: string[] = [];
    for (let i = 0; i < Number(process.env.FUZZ_RUNS ?? 300) && failures.length < 40; i++) {
      const text = generate(next);
      const found = problems(text);
      if (found.length) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(separateDisplayFences(text))}: ${found.join(", ")}`);
    }
    expect(failures).toEqual([]);
  }, 20_000);
});
