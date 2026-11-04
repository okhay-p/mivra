/**
 * The syntax rules behind MathText that aren't plain markdown: when a dollar opens a formula, how math-mode
 * text splits into literal text and formulas, and how a reply splits into blocks that can render separately.
 */

// The dollar rule, from Pandoc. A `$...$` is maths only if the text just inside its dollars isn't whitespace
// and no digit follows it, and the first dollar after the opening one decides: if it can't close, the opening
// one is plain text. So "costs $5 and $10" has no formula, and a scan never goes past the next dollar. A backtick
// before that dollar also makes the opening one plain text, as maths rarely has one and code often has dollars.

export { splitMath, type MathPiece } from "@mivra/protocol";

// The same rule as a micromark tokenizer for markdown mode, so it applies while tokenising: code spans, code
// fences and `\$` have already claimed their text, and a formula can't start inside them. It can't cross a
// code span either, so any backtick before the closing dollar makes the opening one plain text.

type Code = number | null;
type State = (code: Code) => State | undefined;
interface Token {
  type: string;
}
interface Effects {
  enter(type: string): Token;
  exit(type: string): Token;
  consume(code: Code): void;
}

const DOLLAR = 36;
const BACKSLASH = 92;
const BACKTICK = 96;
const SPACE = 32;
// micromark's codes for line endings are below -2; -2 and -1 are a tab and its virtual spaces.
const isLineEnding = (code: Code) => code !== null && code < -2;
const isWhitespace = (code: Code) => code === null || code < 0 || code === SPACE;
const isDigitCode = (code: Code) => code !== null && code >= 48 && code <= 57;

function tokenizeDollarMath(effects: Effects, ok: State, nok: State): State {
  let sizeOpen = 0;
  let size = 0;
  let token: Token;
  let last: Code = null;

  const sequenceOpen: State = (code) => {
    if (code === DOLLAR) {
      effects.consume(code);
      sizeOpen += 1;
      return sequenceOpen;
    }
    if (sizeOpen > 2 || (sizeOpen === 1 && isWhitespace(code))) return nok(code);
    effects.exit("mathTextSequence");
    return between(code);
  };

  const between: State = (code) => {
    if (code === null || code === BACKTICK) return nok(code);
    if (code === DOLLAR) {
      token = effects.enter("mathTextSequence");
      size = 0;
      return sequenceClose(code);
    }
    if (code === SPACE || isLineEnding(code)) {
      const type = code === SPACE ? "space" : "lineEnding";
      effects.enter(type);
      effects.consume(code);
      effects.exit(type);
      last = code;
      return between;
    }
    effects.enter("mathTextData");
    return data(code);
  };

  const data: State = (code) => {
    if (code === null || code === BACKTICK || code === SPACE || code === DOLLAR || isLineEnding(code)) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    last = code;
    return code === BACKSLASH ? escaped : data;
  };

  // `\$` doesn't close a formula, and `\\$` does.
  const escaped: State = (code) => {
    if (code !== DOLLAR && code !== BACKSLASH) return data(code);
    effects.consume(code);
    last = code;
    return data;
  };

  const sequenceClose: State = (code) => {
    if (code === DOLLAR) {
      effects.consume(code);
      size += 1;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      if (isDigitCode(code) || (sizeOpen === 1 && isWhitespace(last))) return nok(code);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok(code);
    }
    if (sizeOpen === 1) return nok(code);
    // A lone dollar inside `$$...$$` is part of the formula.
    token.type = "mathTextData";
    return data(code);
  };

  return (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    return sequenceOpen(code);
  };
}

interface MathExtension {
  text?: Record<number, object>;
}

/** Runs after remark-math and swaps the tokenizer of its text construct, keeping how that construct resolves. */
export function remarkDollarRule(this: { data: () => { micromarkExtensions?: MathExtension[] } }) {
  for (const extension of this.data().micromarkExtensions ?? []) {
    const construct = extension.text?.[DOLLAR];
    if (construct) extension.text![DOLLAR] = { ...construct, tokenize: tokenizeDollarMath };
  }
}

// Splitting a reply into blocks, so a delta re-renders only the last one. A boundary is a blank line outside code
// fences and `$$` blocks, before a line that can't belong to what came before: an indented line may continue a
// list item or indented code, and a list marker may continue a list. Reference and footnote definitions apply
// across the whole text, and raw HTML can hide a fence or run across blank lines, so a reply with any of them stays
// in one piece.
// These patterns may match more than the parser does, which only costs a reply its splitting.

const DEFINITION = /^(?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*\[(?:[^[\]\\]|\\[\s\S]){1,999}\]:/m;
const RAW_HTML = /^ {0,3}<[a-z/!?]/im;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const MATH_OPEN = /^ {0,3}(\$\$+)[^$]*$/;
// Only spaces and tabs may follow a closing fence, as in CommonMark: a non-breaking space makes it a content line.
const FENCE_CLOSE = /^ {0,3}(`+|~+|\$+)[ \t]*$/;

interface Line {
  text: string;
  start: number;
  next: number;
}

/** Splits on every line ending the parser knows, so a lone `\r` can't hide a line from the checks below. */
function* linesOf(source: string): Generator<Line> {
  let start = 0;
  for (const ending of source.matchAll(/\r\n?|\n/g)) {
    const next = ending.index + ending[0].length;
    yield { text: source.slice(start, ending.index), start, next };
    start = next;
  }
  if (start < source.length) yield { text: source.slice(start), start, next: source.length };
}

export function splitBlocks(source: string): string[] {
  if (DEFINITION.test(source) || RAW_HTML.test(source)) return [source];
  const blocks: string[] = [];
  let blockStart = 0;
  let closes: ((line: string) => boolean) | undefined;
  let closesWithList = false;
  let afterBlank = false;
  let inList = false;
  let afterIndented = false;
  for (const { text: line, start } of linesOf(source)) {
    // An indented fence after a list ends here if it's in an item, and not if the item has already ended. Without
    // knowing which, nothing after this can be a boundary for certain.
    if (closes && closesWithList && line.trim() !== "" && !/^\s/.test(line)) break;
    if (closes) {
      if (closes(line)) closes = undefined;
    } else if (line.trim() === "") {
      afterBlank = true;
    } else {
      const marker = LIST_MARKER.test(line);
      // After indented code, the parser may read a list marker, even one after a quote's, as text.
      if (afterBlank && !/^\s/.test(line) && !(marker && inList) && !(afterIndented && CONTAINER_START.test(line))) {
        blocks.push(source.slice(blockStart, start));
        blockStart = start;
        inList = false;
      }
      inList ||= marker;
      afterIndented = /^\s/.test(line);
      afterBlank = false;
      closes = opensBlock(line);
      closesWithList = inList && /^\s/.test(line);
    }
  }
  blocks.push(source.slice(blockStart));
  return blocks;
}

// A `$$` alone on its line opens a display block that closes only on a line holding nothing but a `$` run at
// least as long. Models also write the fence's ends on lines with text: `$$ x = 1` (the parser drops the text as
// the fence's info string) and `x = 1.$$ Next sentence` (the block swallows the rest of the reply). Moving that
// text onto its own lines makes both layouts mean what they look like. It runs before splitting, so the splitter
// and the parser see the same fences. Raw HTML can hide a fence, so a reply with any is left alone, as the
// splitter leaves it in one piece.
//
// The rule is deliberately narrow: only a display block at the top level of the reply is touched, as in a list
// item or a quote, telling a fence's content from code takes the parser's whole container logic. A `$$` or code
// fence at column 0 is always top level, as neither can continue a paragraph lazily, so the scan tracks only
// those. A fence or `$$` line that's indented could be top level or inside a list item; from there the scan can't
// tell code from text, so it stops and leaves the rest as written. One in a container's marker line (`- $$`)
// ends with that container, before the next line at column 0 that isn't one. So a display block inside a list
// or quote keeps the old bug, but code is never touched. Text moved off a closing `$$` line has any block start
// it begins with escaped, so it stays the text it was. Plain text shows the reply as written, without the moves.

/**
 * A column-0 `$$` opener and any text after it on its line, trimmed of spaces and tabs; undefined if the line holds
 * another dollar. A plain scan: the regex it replaced backtracked on long runs of spaces (Sol, round 4).
 */
function mathOpenWithText(line: string): { fence: string; rest: string } | undefined {
  let end = 0;
  while (line[end] === "$") end++;
  if (end < 2 || line.indexOf("$", end) !== -1) return undefined;
  let from = end;
  let to = line.length;
  while (from < to && (line[from] === " " || line[from] === "\t")) from++;
  while (to > from && (line[to - 1] === " " || line[to - 1] === "\t")) to--;
  return { fence: line.slice(0, end), rest: line.slice(from, to) };
}
const CONTAINER_START = /^ {0,3}(?:>|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
// Lines that end a paragraph rather than continuing it lazily.
const INTERRUPTS = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/;

/** Moves text that shares a line with a display block's opening or closing `$$` onto lines of its own. */
export function separateDisplayFences(source: string): string {
  return fenceLines(source).join("");
}

/** A block of a reply: the text to parse, and the source it came from, for showing as plain text. */
export interface ReplyBlock {
  text: string;
  source: string;
}

/**
 * Separates display fences and splits the result into blocks, each with the part of the reply it came from. A
 * boundary always falls at the start of a source line, as moved text never follows a blank line.
 */
export function replyBlocks(source: string): ReplyBlock[] {
  const lines = fenceLines(source);
  // Where each source line starts, keyed by where it starts in the normalised text.
  const starts = new Map<number, number>();
  let offset = 0;
  for (const [i, line] of [...linesOf(source)].entries()) {
    starts.set(offset, line.start);
    offset += lines[i]!.length;
  }
  starts.set(offset, source.length);
  const blocks = splitBlocks(lines.join(""));
  offset = 0;
  const result: ReplyBlock[] = [];
  for (const text of blocks) {
    const from = starts.get(offset);
    const to = starts.get((offset += text.length));
    // Unreachable, but if a boundary missed a line start, show the normalised text rather than the wrong source.
    if (from === undefined || to === undefined) return blocks.map((block) => ({ text: block, source: block }));
    result.push({ text, source: source.slice(from, to) });
  }
  return result;
}

/** What each line of the source becomes, with its line ending. */
export function fenceLines(source: string): string[] {
  const lines = [...linesOf(source)].map((line) => ({ text: line.text, ending: source.slice(line.start + line.text.length, line.next) }));
  const out = lines.map((line) => line.text + line.ending);
  // A byte order mark hides a first-line fence from this scan, though not from the parser: leave such a reply as it is.
  if (!source.includes("$$") || RAW_HTML.test(source) || source.startsWith("\uFEFF")) return out;
  // The top-level code fence or display block that's open, if any.
  let code: ((line: string) => boolean) | undefined;
  let math: number | undefined;
  // What the open display block's TeX so far leaves open, to tell a closing `$$` from dollars inside TeX. Kept as
  // running state, so each line is read once, however long the block.
  let tex: TexState = PLAIN;
  for (const [i, { text, ending }] of lines.entries()) {
    const newline = ending || "\n";
    if (code) {
      if (code(text)) code = undefined;
    } else if (math) {
      const close = FENCE_CLOSE.exec(text)?.[1];
      if (close?.[0] === "$" && close.length >= math) {
        math = undefined;
      } else {
        const run = closingRun(text, math);
        // Dollars inside TeX (`\verb|$$|`, `\text{a$$ b}` even across lines, an `\href` URL, a `%` comment) aren't
        // a fence. If the block's TeX up to the run leaves any of those open, the block is left as written.
        if (run && isPlain(readTex(tex, text.slice(0, run.start)))) {
          const before = text.slice(0, run.start);
          const after = asText(text.slice(run.end).trim());
          out[i] = (before.trim() ? before + newline : "") + text.slice(run.start, run.end) + (after ? newline + after : "") + ending;
          math = undefined;
        } else {
          tex = readTex(tex, text);
        }
      }
    } else if (/^[ \t]/.test(text)) {
      // Indented code, a paragraph's next line, or a fence in a list item or at the top level: past here, the scan
      // can't tell which lines are code.
      if (FENCE_OPEN.test(text.trimStart()) || MATH_OPEN.test(text.trimStart())) break;
    } else if (FENCE_OPEN.test(text)) {
      code = opensBlock(text);
    } else {
      const open = mathOpenWithText(text);
      if (open) {
        const { fence, rest } = open;
        math = fence.length;
        tex = rest ? readTex(PLAIN, rest) : PLAIN;
        if (rest) out[i] = fence + newline + rest + ending;
      }
    }
  }
  return out;
}

// What moved text can start with that would make it something other than a paragraph: a list marker, a quote, a
// heading, a rule, a fence, a definition (with its label closed on this line or not), or an HTML block other than
// an autolink. A setext underline needs a paragraph above it, so can't start one, and a table row keeps its text.
const BLOCK_START = new RegExp(
  [CONTAINER_START.source, INTERRUPTS.source, /^(?:`{3}|~{3}|\$\$)/.source, /^\[(?:[^\]\\]|\\.)*(?:\]:|$)/.source, /^<(?![a-z][a-z\d+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)[a-z/!?]/i.source].join("|"),
);

/** Escapes what would start a block, so moved text stays a paragraph of the text it was. */
function asText(text: string): string {
  if (!BLOCK_START.test(text)) return text;
  return /^\d/.test(text) ? text.replace(/^(\d+)/, "$1\\") : `\\${text}`;
}

/** What a display block's TeX so far leaves open: unclosed braces, or something whose end can't be found. */
interface TexState {
  depth: number;
  uncertain: boolean;
}
const PLAIN: TexState = { depth: 0, uncertain: false };

// Commands after which literal text, and so dollars, can run to a delimiter this scan can't find: `\verb` takes any
// delimiter, and a macro defined with `\def` and its relatives can take an argument up to any text at all.
// Internal commands (any name with `@`, such as `\@ifnextchar`), conditionals (`\if…`) and expansion control
// consume the tokens after them, dollars included, so they're uncertain too. `\includegraphics` takes a raw optional
// `[…]` argument, which can hold dollars too.
const UNCERTAIN_COMMANDS = new Set(["verb", "def", "gdef", "edef", "xdef", "let", "futurelet", "newcommand", "renewcommand", "providecommand", "catcode", "csname", "expandafter", "noexpand", "includegraphics"]);

/** Reads more of a display block's TeX. A `%` comment can hide the dollars and text after it, so it is uncertain too. */
function readTex(state: TexState, text: string): TexState {
  if (state.uncertain) return state;
  let depth = state.depth;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      let end = i + 1;
      // KaTeX lets `@` into command names (`\@ifnextchar`).
      while (end < text.length && /[a-zA-Z@]/.test(text[end]!)) end++;
      const name = text.slice(i + 1, end);
      if (UNCERTAIN_COMMANDS.has(name) || name.includes("@") || name.startsWith("if")) return { depth, uncertain: true };
      // A control word, or the one character a backslash escapes.
      i = end > i + 1 ? end - 1 : i + 1;
    } else if (c === "%") return { depth, uncertain: true };
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return { depth, uncertain: false };
}

/** Whether a `$$` after this TeX can only be the closing fence: every brace closed and nothing uncertain. */
const isPlain = (state: TexState) => !state.uncertain && state.depth === 0;

/** The first run of at least `size` dollars that no backslash escapes. */
function closingRun(line: string, size: number): { start: number; end: number } | undefined {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] !== "$") continue;
    let end = i;
    while (line[end] === "$") end++;
    if (end - i >= size) return { start: i, end };
    i = end - 1;
  }
  return undefined;
}

function opensBlock(line: string): ((line: string) => boolean) | undefined {
  const delimiter = FENCE_OPEN.exec(line)?.[1] ?? MATH_OPEN.exec(line)?.[1];
  if (!delimiter) return undefined;
  return (next) => {
    const close = FENCE_CLOSE.exec(next)?.[1];
    return close !== undefined && close[0] === delimiter[0] && close.length >= delimiter.length;
  };
}

// Markdown parsing and the DOM get far slower than linearly with nesting: 1,000 nested list items take six seconds
// to parse and then overflow the stack. This is a coarse check for text no one would write, not a model of the
// parser: it looks only at line starts and long literal runs, so it can't misfire on a formula. Spaced nesting like
// `[a [a [a ` gets past it, and renders slowly. Anything that makes the parser throw lands in the error boundary.

const MAX_BLOCK_CHARS = 50_000;
const MAX_CONTAINER_DEPTH = 32;
const MAX_INDENT = 200;
const BRACKET_RUN = /\[{33}/;
// Far beyond any rule or blank to fill in, which are ordinary at 40 or so.
const DELIMITER_RUN = /\*{1001}|_{1001}|~{1001}/;
const LINE_CONTAINERS = /^[ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)+/;
const CONTAINER_MARKER = />|[-*+]|\d{1,9}[.)]/g;

export type BlockSection = { kind: "prose" | "math"; text: string } | { kind: "code"; text: string; code: string };

/** Cuts a block at its unindented fences and `$$` blocks, so plain-text fallback can keep code in its box. */
export function blockSections(block: string): BlockSection[] {
  const sections: BlockSection[] = [];
  let start = 0;
  let bodyStart = 0;
  let closes: ((line: string) => boolean) | undefined;
  const close = (end: number, bodyEnd: number) => {
    const text = block.slice(start, end);
    sections.push(block[start] === "$" ? { kind: "math", text } : { kind: "code", text, code: block.slice(bodyStart, bodyEnd) });
    start = end;
    closes = undefined;
  };
  for (const line of linesOf(block)) {
    if (closes) {
      if (closes(line.text)) close(line.next, line.start);
    } else {
      const opens = /^\s/.test(line.text) ? undefined : opensBlock(line.text);
      if (opens) {
        if (line.start > start) sections.push({ kind: "prose", text: block.slice(start, line.start) });
        start = line.start;
        bodyStart = line.next;
        closes = opens;
      }
    }
  }
  if (closes) close(block.length, block.length);
  else if (start < block.length) sections.push({ kind: "prose", text: block.slice(start) });
  return sections;
}

/** Whether a block is too long or too deeply nested to hand to the parser. */
export function isTooDeep(block: string): boolean {
  if (block.length > MAX_BLOCK_CHARS) return true;
  // A definition or raw HTML can make a fence plain text to the parser, so nothing in the block is exempt as code.
  if (DEFINITION.test(block) || RAW_HTML.test(block)) return isProseTooDeep(block);
  return blockSections(block).some((section) => section.kind === "prose" && isProseTooDeep(section.text));
}

function isProseTooDeep(prose: string): boolean {
  for (const { text: line } of linesOf(prose)) {
    if (BRACKET_RUN.test(line) || DELIMITER_RUN.test(line)) return true;
    if (/^[ \t]*/.exec(line)![0].length > MAX_INDENT) return true;
    const containers = LINE_CONTAINERS.exec(line)?.[0];
    if (containers && (containers.match(CONTAINER_MARKER)?.length ?? 0) > MAX_CONTAINER_DEPTH) return true;
  }
  return false;
}
