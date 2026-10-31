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
// to parse and then overflow the stack. Nobody writes these limits' worth of nesting on purpose. The checks are
// there to catch hostile text, so what they skip must really be what the parser skips: when unsure, they count it.

const MAX_CONTAINER_DEPTH = 32;
const MAX_INDENT = 200;
const MAX_INLINE_DEPTH = 32;
const MAX_BLOCK_CHARS = 50_000;
const MAX_FORMULA_CHARS = 5000;
// Openers with no partner don't nest, but the parser still has to keep them all in play.
const MAX_OPEN_BRACKETS = 1000;
const LINE_CONTAINERS = /^[ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)+/;
const CONTAINER_MARKER = />|[-*+]|\d{1,9}[.)]/g;
const LONG_DELIMITER_RUN = new RegExp(`[*_~]{${MAX_INLINE_DEPTH + 1},}`, "g");
// What can swallow a backtick or dollar before the parser sees it, so that a span found here isn't one there:
// inline HTML, an autolink, a link's destination or title, or a reference's label.
const SWALLOWS_DELIMITERS = /<|\][([][^\]]*[`$]/;

export type BlockSection = { kind: "prose" | "math"; text: string } | { kind: "code"; text: string; code: string };

/**
 * Cuts a block at the fences that are certain to be fences. A definition can run across lines and raw HTML across
 * fences, either of which would make a fence here plain text there, and everything after it live markdown, so
 * from the first line that might start one the rest counts as prose. So does a fence that might be in a list item.
 */
export function blockSections(block: string): BlockSection[] {
  const sections: BlockSection[] = [];
  let start = 0;
  let bodyStart = 0;
  let closes: ((line: string) => boolean) | undefined;
  let certain = true;
  const close = (end: number, bodyEnd: number) => {
    const text = block.slice(start, end);
    sections.push(block[start] === "$" ? { kind: "math", text } : { kind: "code", text, code: block.slice(bodyStart, bodyEnd) });
    start = end;
    closes = undefined;
  };
  for (const line of linesOf(block)) {
    if (closes) {
      if (closes(line.text)) close(line.next, line.start);
    } else if (certain) {
      if (/^[[<]/.test(line.text.replace(LINE_CONTAINERS, "").trimStart())) {
        certain = false;
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
  }
  if (closes) close(block.length, block.length);
  else if (start < block.length) sections.push({ kind: "prose", text: block.slice(start) });
  return sections;
}

/** Whether a block is nested too deeply, or is too long, to parse without freezing the page. */
export function isTooDeep(block: string): boolean {
  if (block.length > MAX_BLOCK_CHARS) return true;
  return blockSections(block).some((section) => (section.kind === "math" ? section.text.length > MAX_FORMULA_CHARS : section.kind === "prose" && isProseTooDeep(section.text)));
}

function isProseTooDeep(prose: string): boolean {
  // Inline markup can't cross a blank line, so what comes after one starts again from no nesting.
  let inline: string[] = [];
  for (const { text: line } of linesOf(prose)) {
    if (line.trim() === "") {
      if (isInlineTooDeep(inline)) return true;
      inline = [];
      continue;
    }
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent > MAX_INDENT) return true;
    const containers = LINE_CONTAINERS.exec(line)?.[0];
    if (containers && (containers.match(CONTAINER_MARKER)?.length ?? 0) > MAX_CONTAINER_DEPTH) return true;
    inline.push(line);
  }
  return isInlineTooDeep(inline);
}

function isInlineTooDeep(lines: string[]): boolean {
  const raw = lines.join("\n");
  const visible = SWALLOWS_DELIMITERS.test(raw) ? [undefined] : lines.map(withoutSpans);
  if (visible.includes(undefined)) return bracketsCouldNest(raw) || delimitersNest(raw);
  const text = visible.join("\n");
  return bracketsNest(text) || delimitersNest(text);
}

/**
 * A line without its code spans and formulas, or undefined if the line's spans aren't all certain: one left open
 * might continue on the next line, where it isn't safe to follow, and a `|` may be a table cell's edge instead.
 */
function withoutSpans(line: string): string | undefined {
  let visible = "";
  let i = 0;
  while (i < line.length) {
    const char = line[i]!;
    if (char === "\\") {
      visible += line.slice(i, i + 2);
      i += 2;
    } else if (char === "`" || char === "$") {
      if (char === "$" && line[i + 1] === "$") return undefined;
      const end = char === "`" ? codeSpanEnd(line, i) : closingDollarEnd(line, i);
      if (end === undefined) {
        if (char === "`" || !line.includes("$", i + 1)) return undefined;
        visible += char;
        i += 1;
      } else {
        if (end - i > MAX_FORMULA_CHARS || line.slice(i, end).includes("|")) return undefined;
        i = end;
      }
    } else {
      visible += char;
      i += 1;
    }
  }
  return visible;
}

function closingDollarEnd(line: string, open: number): number | undefined {
  const close = closingDollar(line, open);
  return close === undefined ? undefined : close + 1;
}

function codeSpanEnd(line: string, open: number): number | undefined {
  let contentStart = open;
  while (line[contentStart] === "`") contentStart += 1;
  const size = contentStart - open;
  let run = line.indexOf("`", contentStart);
  while (run !== -1) {
    let runEnd = run;
    while (line[runEnd] === "`") runEnd += 1;
    if (runEnd - run === size) return runEnd;
    run = line.indexOf("`", runEnd);
  }
  return undefined;
}

/** Nesting of brackets that have partners: half-open intervals like `[0,1)` don't nest however many there are. */
function bracketsNest(text: string): boolean {
  const deepestInside: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
    } else if (char === "[") {
      if (deepestInside.push(0) > MAX_OPEN_BRACKETS) return true;
    } else if (char === "]" && deepestInside.length > 0) {
      const depth = deepestInside.pop()! + 1;
      if (depth > MAX_INLINE_DEPTH) return true;
      const parent = deepestInside.length - 1;
      if (parent >= 0) deepestInside[parent] = Math.max(deepestInside[parent]!, depth);
    }
  }
  return false;
}

/** The most they could nest whichever of them turn out to be real: enough openers followed by enough closers. */
function bracketsCouldNest(text: string): boolean {
  let openers = 0;
  let closers = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "]") closers += 1;
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "[") openers += 1;
    else if (text[i] === "]") closers -= 1;
    if (openers > MAX_OPEN_BRACKETS || Math.min(openers, closers) > MAX_INLINE_DEPTH) return true;
  }
  return false;
}

/** A long run only nests with another: one that can open, then one that can close. A rule or a blank to fill in can't. */
function delimitersNest(text: string): boolean {
  let canClose = false;
  for (const run of text.matchAll(LONG_DELIMITER_RUN)) {
    const before = text[run.index - 1];
    const after = text[run.index + run[0].length];
    if (canClose && before !== undefined && !isSpace(before)) return true;
    canClose ||= after !== undefined && !isSpace(after);
  }
  return false;
}
