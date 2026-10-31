/**
 * The syntax rules behind MathText that aren't plain markdown: when a dollar opens a formula, how math-mode
 * text splits into literal text and formulas, and how a reply splits into blocks that can render separately.
 */

// The dollar rule, from Pandoc. A `$...$` is maths only if the text just inside its dollars isn't whitespace
// and no digit follows it, and the first dollar after the opening one decides: if it can't close, the opening
// one is plain text. So "costs $5 and $10" has no formula, and a scan never goes past the next dollar. A backtick
// before that dollar also makes the opening one plain text, as maths rarely has one and code often has dollars.

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";

export type MathPiece = { text: string } | { formula: string };

/** For math mode: everything is literal except `$...$` formulas, and `\$`, which is a literal dollar. */
export function splitMath(source: string): MathPiece[] {
  const pieces: MathPiece[] = [];
  let literal = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\" && source[i + 1] === "$") {
      literal += "$";
      i += 2;
    } else if (char !== "$") {
      literal += char;
      i += 1;
    } else if (source[i + 1] === "$") {
      // A dollar next to another is never a delimiter here, so "$$x$$" stays as written.
      while (source[i] === "$") {
        literal += "$";
        i += 1;
      }
    } else {
      const close = closingDollar(source, i);
      if (close === undefined) {
        literal += "$";
        i += 1;
      } else {
        if (literal) pieces.push({ text: literal });
        literal = "";
        pieces.push({ formula: source.slice(i + 1, close) });
        i = close + 1;
      }
    }
  }
  if (literal) pieces.push({ text: literal });
  return pieces;
}

function closingDollar(source: string, open: number): number | undefined {
  let close = open + 1;
  while (close < source.length && source[close] !== "$") {
    close += source[close] === "\\" && (source[close + 1] === "$" || source[close + 1] === "\\") ? 2 : 1;
  }
  if (close >= source.length || close === open + 1 || source[close + 1] === "$") return undefined;
  if (isSpace(source[open + 1]) || isSpace(source[close - 1]) || isDigit(source[close + 1])) return undefined;
  return /`|\n\s*\n/.test(source.slice(open, close)) ? undefined : close;
}

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
// across the whole text, so a reply with any of them stays in one piece.

const DEFINITION = /^[ \t>]*\[[^\]\n]+\]:/m;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const MATH_OPEN = /^ {0,3}\$\$[^$]*$/;
const MATH_CLOSE = /^ {0,3}\$\$+[ \t]*$/;

export function splitBlocks(source: string): string[] {
  if (DEFINITION.test(source)) return [source];
  const blocks: string[] = [];
  let blockStart = 0;
  let closes: ((line: string) => boolean) | undefined;
  let afterBlank = false;
  let inList = false;
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    if (closes) {
      if (closes(line)) closes = undefined;
    } else if (line.trim() === "") {
      afterBlank = true;
    } else {
      const marker = LIST_MARKER.test(line);
      if (afterBlank && !/^\s/.test(line) && !(marker && inList)) {
        blocks.push(source.slice(blockStart, lineStart));
        blockStart = lineStart;
        inList = false;
      }
      inList ||= marker;
      afterBlank = false;
      closes = opensBlock(line);
    }
    lineStart = lineEnd + 1;
  }
  blocks.push(source.slice(blockStart));
  return blocks;
}

function opensBlock(line: string): ((line: string) => boolean) | undefined {
  const fence = FENCE_OPEN.exec(line)?.[1];
  if (fence) {
    const closing = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`);
    return (next) => closing.test(next);
  }
  return MATH_OPEN.test(line) ? (next) => MATH_CLOSE.test(next) : undefined;
}

// Markdown parsing and the DOM get far slower than linearly with nesting: 1,000 nested list items take six seconds
// to parse and then overflow the stack. Nobody writes these limits' worth of nesting on purpose.

const MAX_CONTAINER_DEPTH = 32;
const MAX_INDENT = 200;
const MAX_INLINE_DEPTH = 32;
const MAX_BLOCK_CHARS = 50_000;
const LINE_CONTAINERS = /^[ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)+/;
const CONTAINER_MARKER = />|[-*+]|\d{1,9}[.)]/g;
const LONG_DELIMITER_RUN = new RegExp(`[*_~]{${MAX_INLINE_DEPTH + 1}}`);

/** Whether a block is nested too deeply, or is too long, to parse without freezing the page. */
export function isTooDeep(block: string): boolean {
  if (block.length > MAX_BLOCK_CHARS || LONG_DELIMITER_RUN.test(block)) return true;
  let brackets = 0;
  for (const char of block) {
    if (char === "[" && ++brackets > MAX_INLINE_DEPTH) return true;
    if (char === "]" && brackets > 0) brackets -= 1;
  }
  for (const line of block.split("\n")) {
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent > MAX_INDENT) return true;
    const containers = LINE_CONTAINERS.exec(line)?.[0];
    if (containers && (containers.match(CONTAINER_MARKER)?.length ?? 0) > MAX_CONTAINER_DEPTH) return true;
  }
  return false;
}
