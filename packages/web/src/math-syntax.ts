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
// and the parser see the same fences. Code is skipped, and raw HTML can hide a fence, so a reply with any is left
// alone, as the splitter leaves it in one piece.
//
// Fences sit inside list items and quotes, so the scan follows those containers the way the parser does: a line
// is checked against each open container (a quote needs its `>`, a list item its content column or a blank
// line), and what's left is the line's content. A line that fails to continue a container ends it and
// any fence inside it, and only a paragraph can carry on lazily. Fence indentation counts from the content
// column, so four spaces past it is indented code. A paragraph ends at a rule, a setext underline or a table's
// delimiter row, and while one is open (or indented code is) a list item can't start empty or at a number other
// than 1. Text moved off a closing `$$` line has any block start it begins with escaped, so it stays the text it
// was. Plain text shows the reply as written, without the moves. It's a sketch of the parser's container rules,
// not all of them.

const MATH_OPEN_WITH_TEXT = /^( {0,3})(\$\$+)[ \t]*([^$]*?)[ \t]*$/;
const CONTAINER_START = /^ {0,3}(?:>|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
// Lines that end a paragraph rather than continuing it lazily.
const INTERRUPTS = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/;

const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

// An item's width is how far its content sits from where the item starts (its parent's content), so a line must
// be indented that far past its parent's content to continue it. An item that starts with a blank line is empty
// until a line of content, and a blank line ends it while it's empty.
type Container = { kind: "quote" } | { kind: "item"; width: number; empty: boolean };

/** The column after `text`, which starts at `column`, with tabs stopping every four columns. */
function advance(text: string, column: number): number {
  for (const char of text) column = char === "\t" ? column + 4 - (column % 4) : column + 1;
  return column;
}

/** Leading spaces and tabs from `pos`, as the end position and column. */
function indentation(line: string, pos: number, column: number): { pos: number; column: number } {
  while (line[pos] === " " || line[pos] === "\t") column = advance(line[pos++]!, column);
  return { pos, column };
}

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
  const lines = [...linesOf(source)];
  const unchanged = () => lines.map((line) => source.slice(line.start, line.next));
  if (!source.includes("$$") || RAW_HTML.test(source)) return unchanged();
  const out: string[] = [];
  const containers: Container[] = [];
  let code: ((line: string) => boolean) | undefined;
  let indentedCode = false;
  let math: { indent: string; size: number } | undefined;
  let paragraph = false;
  // A GFM table, and the paragraph line that could become its header.
  let table = false;
  let paragraphLine = "";
  for (const line of lines) {
    const ending = source.slice(line.start + line.text.length, line.next);
    const newline = ending || "\n";
    const text = line.text;

    // Continue the open containers. `prefix` is what a continuation line inside them starts with.
    let pos = 0;
    let column = 0;
    let prefix = "";
    let matched = 0;
    for (const container of containers) {
      const indent = indentation(text, pos, column);
      if (container.kind === "item" && indent.pos === text.length) {
        // A blank line continues a list item that has content, and ends a quote.
        if (container.empty) break;
        matched++;
        continue;
      }
      if (container.kind === "quote") {
        if (indent.column - column > 3 || text[indent.pos] !== ">") break;
        let end = indent.pos + 1;
        if (text[end] === " " || text[end] === "\t") end++;
        prefix += text.slice(pos, end);
        column = advance(text.slice(pos, end), column);
        pos = end;
      } else {
        if (indent.column - column < container.width) break;
        prefix += " ".repeat(container.width);
        // A tab can reach past the content column; the rest of it then counts as content indentation.
        const target = column + container.width;
        while (column < target) column = advance(text[pos++]!, column);
      }
      matched++;
    }

    if (matched < containers.length) {
      const rest = text.slice(pos);
      const lazy = paragraph && rest.trim() !== "" && !code && !math && !indentedCode && !CONTAINER_START.test(rest) && !INTERRUPTS.test(rest) && !FENCE_OPEN.test(rest) && !MATH_OPEN.test(rest);
      if (lazy) {
        paragraphLine = rest;
        out.push(text + ending);
        continue;
      }
      containers.length = matched;
      code = undefined;
      math = undefined;
      indentedCode = false;
      paragraph = false;
      table = false;
    }

    // Open new containers, unless the line belongs to a fence that's still open.
    if (!code && !math) {
      // Whether the line could interrupt a paragraph or indented code. It holds for every container the line opens.
      const interrupting = paragraph || indentedCode;
      for (;;) {
        const indent = indentation(text, pos, column);
        // Four columns of indentation is indented code, unless it continues a paragraph.
        if (indent.column - column > 3) break;
        const quote = text[indent.pos] === ">";
        const marker = quote ? undefined : /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/.exec(text.slice(indent.pos))?.[0];
        if (!quote && !marker) break;
        // A list item interrupting a paragraph can't be empty, and a numbered one must start at 1. The parser applies
        // the same rule after indented code, even past blank lines, and to the rest of the line once it applies.
        if (marker && interrupting && (text.slice(indent.pos + marker.length).trim() === "" || (/\d/.test(marker) && !/^0*1\D/.test(marker)))) break;
        // A line of dashes or stars is a rule, not a list.
        if (marker && INTERRUPTS.test(text.slice(indent.pos))) break;
        if (quote) {
          let end = indent.pos + 1;
          if (text[end] === " " || text[end] === "\t") end++;
          prefix += text.slice(pos, end);
          column = advance(text.slice(pos, end), column);
          pos = end;
          containers.push({ kind: "quote" });
        } else {
          const markerEnd = indent.pos + marker!.length;
          const markerColumn = advance(text.slice(pos, markerEnd), column);
          const after = indentation(text, markerEnd, markerColumn);
          // One to four spaces after the marker set the content column; more, or none, put it one past the marker.
          const content = after.pos === text.length || after.column - markerColumn > 4 ? markerColumn + 1 : after.column;
          const width = content - column;
          prefix += " ".repeat(width);
          let end = markerEnd;
          column = markerColumn;
          while (column < content && end < text.length) column = advance(text[end++]!, column);
          column = Math.max(column, content);
          pos = end;
          containers.push({ kind: "item", width, empty: true });
        }
        paragraph = false;
        table = false;
        indentedCode = false;
      }
    }

    const head = text.slice(0, pos);
    let content = text.slice(pos);
    const blank = content.trim() === "";
    const contentIndent = indentation(text, pos, column).column - column;
    if (code) {
      if (code(content)) code = undefined;
    } else if (math) {
      const close = FENCE_CLOSE.exec(content)?.[1];
      if (close?.[0] === "$" && close.length >= math.size) {
        math = undefined;
      } else {
        const run = closingRun(content, math.size);
        if (run) {
          const before = content.slice(0, run.start);
          const after = asText(content.slice(run.end).trim());
          const fence = prefix + math.indent + content.slice(run.start, run.end);
          content = before.trim() ? before + newline + fence : fence.slice(prefix.length);
          if (after) content += newline + prefix + math.indent + after;
          math = undefined;
          paragraph = Boolean(after);
          paragraphLine = after;
          table = false;
        }
      }
    } else if (blank) {
      paragraph = false;
      table = false;
    } else if (contentIndent > 3 && !paragraph) {
      indentedCode = true;
    } else if (FENCE_OPEN.test(content)) {
      code = opensBlock(content);
      paragraph = false;
      table = false;
      indentedCode = false;
    } else {
      indentedCode = false;
      const open = MATH_OPEN_WITH_TEXT.exec(content);
      if (open) {
        const [, indent, fence, rest] = open as unknown as [string, string, string, string];
        math = { indent, size: fence.length };
        if (rest) content = indent + fence + newline + prefix + indent + rest;
        paragraph = false;
        table = false;
      } else if (table && !INTERRUPTS.test(content)) {
        // A table row. A table takes no lazy lines, and doesn't stop a list item from starting.
      } else if (paragraph && isDelimiterRow(content) && cellCount(content) === cellCount(paragraphLine)) {
        // The paragraph's last line was a table's header.
        paragraph = false;
        table = true;
      } else {
        table = false;
        // A rule ends a paragraph, and so does a setext underline, which makes it a heading.
        paragraph = !INTERRUPTS.test(content) && !(paragraph && SETEXT_UNDERLINE.test(content));
        paragraphLine = content;
      }
    }
    // An item holding another container, or a line of content, isn't empty.
    containers.forEach((container, i) => {
      if (container.kind === "item" && (i < containers.length - 1 || !blank)) container.empty = false;
    });
    out.push(head + content + ending);
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

/** A GFM table's delimiter row, such as `| --- | :-: |`. Without a pipe it would be a rule or an underline. */
function isDelimiterRow(line: string): boolean {
  return line.includes("|") && /^ {0,3}(?=[|:-])\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line);
}

/** How many cells a table row has: its unescaped pipes, less one at either end. */
function cellCount(line: string): number {
  const row = line.trim().replace(/^\|/, "").replace(/(^|[^\\])\|$/, "$1");
  return 1 + (row.match(/(?<!\\)\|/g)?.length ?? 0);
}

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
