/**
 * Syntax highlighting for the languages Mivra's lessons mostly show: JavaScript, TypeScript, JSX and Python. The
 * source is parsed with Lezer and split into text runs with token classes (`tok-keyword`, `tok-string`, ...), which
 * `styles.css` colours. It only ever produces text plus class names, never markup, so model code stays inert. Any
 * other language, or code that fails to parse, comes back as plain text.
 */
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";

/** A run of text and its token classes, if any. */
export interface Token {
  text: string;
  className?: string;
}

type Parser = typeof jsParser;
const parsers = new Map<string, Parser>();
function parserFor(dialect: string): Parser {
  let parser = parsers.get(dialect);
  if (!parser) {
    parser = dialect === "python" ? pythonParser : jsParser.configure({ dialect });
    parsers.set(dialect, parser);
  }
  return parser;
}

const DIALECTS: Record<string, string> = {
  javascript: "",
  js: "",
  mjs: "",
  cjs: "",
  node: "",
  "node.js": "",
  nodejs: "",
  jsx: "jsx",
  react: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "jsx ts",
  python: "python",
  python3: "python",
  py: "python",
};

/** The Lezer dialect for a language label or fence name, or undefined when it isn't one we highlight. */
export function dialectOf(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const key = language.trim().toLowerCase();
  return Object.hasOwn(DIALECTS, key) ? DIALECTS[key] : undefined;
}

/**
 * Lezer recovers from broken code by trying alternatives, which pathological input can make slow: 4,000 `<` as JSX
 * takes seconds, while real code of that size takes tens of milliseconds (a cold first parse, a few hundred).
 * Colouring isn't worth a stalled page, so a parse that runs past its budget is dropped and the code shows plain.
 */
export const PARSE_BUDGET_MS = 300;
function parseWithin(parser: Parser, source: string) {
  const parse = parser.startParse(source);
  const deadline = performance.now() + PARSE_BUDGET_MS;
  for (;;) {
    const tree = parse.advance();
    if (tree) return tree;
    if (performance.now() > deadline) return undefined;
  }
}

/**
 * The source's lines, each split into highlighted runs, or undefined for a language we don't highlight. Lines are
 * split on `\n` only, so the caller normalises line endings first; the result always has one entry per line.
 */
export function highlightLines(source: string, language: string | undefined): Token[][] | undefined {
  const dialect = dialectOf(language);
  if (dialect === undefined) return undefined;
  const lines: Token[][] = [[]];
  try {
    const tree = parseWithin(parserFor(dialect), source);
    if (!tree) return undefined;
    highlightCode(
      source,
      tree,
      classHighlighter,
      (text, classes) => lines[lines.length - 1]!.push(classes ? { text, className: classes } : { text }),
      () => lines.push([]),
    );
  } catch {
    return undefined;
  }
  // Highlighting is cosmetic: if it ever loses or adds text, show the code as it is.
  if (lines.map((line) => line.map((t) => t.text).join("")).join("\n") !== source) return undefined;
  return lines;
}
