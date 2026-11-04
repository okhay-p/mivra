import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";
import { describe, expect, it } from "vitest";
import { fenceLines, remarkDollarRule, replyBlocks, separateDisplayFences } from "../src/math-syntax.js";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { line: number }; end: { line: number } };
}

const processor = unified()
  .use(remarkParse)
  .use([remarkGfm, remarkMath, remarkDollarRule] as unknown as PluggableList);

/** The parser's tree for `text`, as MathText's plugins parse it. */
const parse = (text: string) => processor.runSync(processor.parse(text)) as unknown as MdNode;

/**
 * The blocks' top-level nodes, without positions, to compare a split parse with a whole one. Maths that differs only
 * in surrounding whitespace renders the same, so it compares trimmed, without the `data` remark-math derives from
 * its value (which keeps the whitespace).
 */
const shape = (texts: string[]) =>
  JSON.stringify(texts.flatMap((text) => parse(text).children ?? []), function (this: MdNode, key, value: unknown) {
    if (key === "position") return undefined;
    const math = this.type === "math" || this.type === "inlineMath";
    if (math && key === "data") return undefined;
    return math && key === "value" ? (value as string).trim() : value;
  });

function* nodes(node: MdNode): Generator<MdNode> {
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}

const VISIBLE = ["text", "inlineCode", "code", "html", "math", "inlineMath"];

/** The words that show in the parse of `text`; a definition's, for one, don't. */
function shownWords(text: string): Set<string> {
  const shown = new Set<string>();
  for (const node of nodes(parse(text))) if (VISIBLE.includes(node.type)) for (const word of node.value!.match(/w\d+/g) ?? []) shown.add(word);
  return shown;
}

/** The line ranges of the code blocks in `text`'s parse, with their values. */
const codeBlocks = (text: string) => [...nodes(parse(text))].filter((node) => node.type === "code").map((node) => ({ start: node.position!.start.line, end: node.position!.end.line, value: node.value! }));

/**
 * What's wrong with how `text` is normalised. Each line the normaliser rewrites must be one the parser puts in a
 * display block at the top level, given the rewrites before it (so the first is checked against the reply as
 * written), so it never touches code, a list item, a quote, a paragraph or anything else. Afterwards no code block
 * may hold a rewritten line, the code blocks before the first rewrite must be unchanged, every word of a rewritten
 * line must still show, the result must normalise to itself, and its blocks must parse the same as the whole.
 */
function problems(text: string): string[] {
  let edited: string[];
  try {
    edited = fenceLines(text);
  } catch (error) {
    return [String(error)];
  }
  const original = text.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) ?? [];
  if (edited.length !== original.length) return [`returned ${edited.length} lines for ${original.length}`];
  const found: string[] = [];
  const current = [...original];
  const moved = new Set<string>();
  // The first line of each source line in the normalised text, and whether the normaliser changed it.
  const changed: boolean[] = [];
  let firstChange: number | undefined;
  for (const [i, line] of edited.entries()) {
    const lineCount = line.split(/\r\n?|\n/).length - (/(?:\r\n?|\n)$/.test(line) ? 1 : 0);
    for (let k = 0; k < Math.max(lineCount, 1); k++) changed.push(line !== original[i]);
    if (line === original[i]) continue;
    const at = current.slice(0, i).join("").split(/\r\n?|\n/).length;
    firstChange ??= at;
    const block = parse(current.join("")).children?.find((node) => node.type === "math" && node.position!.start.line <= at && at <= node.position!.end.line);
    if (!block) found.push(`rewrote line ${at}, which isn't in a top-level display block`);
    current[i] = line;
    for (const word of original[i]!.match(/w\d+/g) ?? []) moved.add(word);
  }
  const normalised = edited.join("");
  if (normalised === text) return found;
  if (separateDisplayFences(normalised) !== normalised) found.push("not idempotent");
  const before = (blocks: ReturnType<typeof codeBlocks>) => blocks.filter((code) => code.end < firstChange!).map((code) => code.value);
  const after = codeBlocks(normalised);
  if (JSON.stringify(before(codeBlocks(text))) !== JSON.stringify(before(after))) found.push("changed code before the first rewrite");
  for (const code of after) if (changed.slice(code.start - 1, code.end).some(Boolean)) found.push(`put a rewritten line in code at line ${code.start}`);
  // Words on lines it didn't touch can turn into anything once a block closes earlier, as the reply meant them to.
  const shown = shownWords(normalised);
  const hidden = [...moved].filter((word) => !shown.has(word));
  if (hidden.length) found.push(`hid ${hidden.join(" ")}`);
  const blocks = replyBlocks(text);
  if (blocks.map((block) => block.source).join("") !== text) found.push("block sources don't make up the reply");
  if (shape(blocks.map((block) => block.text)) !== shape([normalised])) found.push("blocks parse differently from the whole");
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

// Half the lines start at column 0, as only top-level blocks are rewritten.
const PREFIXES = [...Array<string>(24).fill(""), "\t", " ", "- ", "-", "* ", "1. ", "2. ", "1)", "10. ", "> ", ">", "  ", "   ", "    ", "     ", "      ", "> - ", "- > ", "  - ", "  > ", ">  ", "1. - "];
// `W` becomes a fresh word, so a missing word shows exactly what was lost.
const CONTENTS = ["", "", "W", "W W", "$$", "$$", "$$ W", "W$$ W", "W$$", "$$W$$ W", "```", "~~~", "===", "---", "-", "***", "# W", "[W]: W", "W$$ [W]: W", "W$$ - W", "W$$ # W", "W$$ > W", "W$$ <div>W", "W$$ 1. W", "W$$ ```", "W$$ ===", "W$$ ---", "W$$ | W |", "|---|", "W $$ W", "\\$$ W", "$$$", "W$$$ W", "W$$ W$$ W", "    W$$ W", "W $$ W $$", "| W | W |", "|---|---|", "---|", "W | W", "W\\\\|W", "$$W", "W$$", "$$$", "  $$", " ```"];

function generate(next: () => number): string {
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)]!;
  let word = 0;
  const lines = Array.from({ length: 1 + Math.floor(next() * 7) }, () => pick(PREFIXES) + pick(CONTENTS));
  return lines.join(next() < 0.1 ? "\r\n" : "\n").replace(/W/g, () => `w${word++}`);
}

// A few hundred replies keep this under two seconds. To search further, set FUZZ_SEED and FUZZ_RUNS, say
// FUZZ_RUNS=15000; the timeout grows with the runs.
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);

describe("separateDisplayFences against the parser", () => {
  it("only rewrites top-level display blocks, over seeded random replies", () => {
    const next = random(Number(process.env.FUZZ_SEED ?? 30));
    const failures: string[] = [];
    for (let i = 0; i < RUNS && failures.length < 40; i++) {
      const text = generate(next);
      const found = problems(text);
      if (found.length) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(separateDisplayFences(text))}: ${found.join(", ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(20_000, RUNS * 20));
});
