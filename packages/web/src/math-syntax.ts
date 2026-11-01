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
const FENCE_CLOSE = /^ {0,3}(`+|~+|\$+)\s*$/;

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
      if (afterBlank && !/^\s/.test(line) && !(marker && inList)) {
        blocks.push(source.slice(blockStart, start));
        blockStart = start;
        inList = false;
      }
      inList ||= marker;
      afterBlank = false;
      closes = opensBlock(line);
      closesWithList = inList && /^\s/.test(line);
    }
  }
  blocks.push(source.slice(blockStart));
  return blocks;
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
