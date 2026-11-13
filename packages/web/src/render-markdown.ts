/**
 * Turns one block of a reply into a tree that's cheap to show: markdown parsed, links checked and every formula
 * typeset. It touches no DOM, so it runs in the render worker as well as on the main thread, and what it returns
 * survives `postMessage`.
 */
import type { Element, ElementContent, Nodes, Root } from "hast";
import { urlAttributes } from "html-url-attributes";
import katex from "katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";
import { visit } from "unist-util-visit";
import { highlightLines } from "./highlight.js";
import { remarkDollarRule } from "./math-syntax.js";

export interface RenderedBlock {
  tree: Root;
  /** KaTeX's HTML for each formula, which the tree refers to by index in a `data-formula` span. */
  formulas: string[];
}

const LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

/** Absolute http, https and mailto links only. Anything else, including a relative URL, is no link at all. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return LINK_PROTOCOLS.includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

/** Replaces the parser's verdict on a one-line `$$x$$`, which it calls inline, with the display maths it reads as. */
function remarkDisplayDollars() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visitNode = (node: MdNode) => {
      for (const child of node.children ?? []) {
        const start = child.position?.start.offset;
        if (child.type === "inlineMath" && start !== undefined && source.startsWith("$$", start)) {
          child.data = { ...child.data, hProperties: { ...child.data?.hProperties, className: ["language-math", "math-display"] } };
        }
        visitNode(child);
      }
    };
    visitNode(tree);
  };
}

const remarkPlugins = [remarkGfm, remarkMath, remarkDollarRule, remarkDisplayDollars] as unknown as PluggableList;

const processor = unified()
  .use(remarkParse)
  .use(remarkPlugins)
  // Raw HTML stays in the tree only to be turned into text below.
  .use(remarkRehype, { allowDangerousHtml: true });

// Typeset formulas are kept, so a streaming paragraph doesn't typeset the same 100 formulas again per delta.
const FORMULA_CACHE_SIZE = 1000;
const formulaCache = new Map<string, string>();

/** Forgets typeset formulas. For tests that count calls to KaTeX. */
export function clearFormulaCache() {
  formulaCache.clear();
}

/**
 * KaTeX escapes its input and, with trust: false, won't produce anything active (\href, \includegraphics), which is
 * why its HTML is safe to insert. Invalid LaTeX shows as its source in errorColor. strict: "ignore" only silences
 * console warnings. Returns undefined if KaTeX throws anyway.
 */
export function typeset(source: string, display: boolean): string | undefined {
  const key = `${display ? "D" : "I"}${source}`;
  const cached = formulaCache.get(key);
  if (cached !== undefined) {
    formulaCache.delete(key);
    formulaCache.set(key, cached);
    return cached;
  }
  let html: string;
  try {
    html = katex.renderToString(source, { displayMode: display, trust: false, strict: "ignore", throwOnError: false, errorColor: "var(--destructive)" });
  } catch {
    return undefined;
  }
  formulaCache.set(key, html);
  if (formulaCache.size > FORMULA_CACHE_SIZE) formulaCache.delete(formulaCache.keys().next().value!);
  return html;
}

const classes = (node: Element) => {
  const value = node.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
};
const isMathCode = (node: ElementContent | undefined): boolean => node?.type === "element" && node.tagName === "code" && classes(node).includes("language-math");
const textOf = (node: Element) => node.children.map((child) => (child.type === "text" ? child.value : "")).join("");

/** A fence's code as token spans, for the languages `highlightLines` knows. Text and class names only. */
function highlightFence(code: Element) {
  const language = classes(code)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
  const lines = highlightLines(textOf(code), language);
  if (!lines) return;
  code.children = lines.flatMap((line, i): ElementContent[] => [
    ...(i > 0 ? [{ type: "text" as const, value: "\n" }] : []),
    ...line.map((token): ElementContent =>
      token.className
        ? { type: "element", tagName: "span", properties: { className: token.className.split(" ") }, children: [{ type: "text", value: token.text }] }
        : { type: "text", value: token.text },
    ),
  ]);
}

/** Parses and typesets one block. Throws if the parser does. */
export function renderMarkdown(text: string): RenderedBlock {
  const tree = processor.runSync(processor.parse(text), text) as Root;
  const formulas: string[] = [];

  const formula = (source: string, display: boolean): Element => {
    const html = typeset(source, display);
    if (html === undefined) return { type: "element", tagName: "span", properties: { className: ["katex-error"] }, children: [{ type: "text", value: source }] };
    formulas.push(html);
    return { type: "element", tagName: "span", properties: { className: ["math-text-formula"], dataFormula: formulas.length - 1 }, children: [] };
  };

  visit(tree, (node: Nodes, index, parent) => {
    delete node.position;
    if (!parent || index === undefined) return;
    // Raw HTML shows as the text it is.
    if (node.type === "raw") {
      parent.children[index] = { type: "text", value: node.value };
      return;
    }
    if (node.type !== "element") return;
    // `$$` blocks and ```math fences arrive as a <pre> around the inline maths' <code>.
    if (node.tagName === "pre" && node.children.length === 1 && isMathCode(node.children[0])) {
      parent.children[index] = formula(textOf(node.children[0] as Element).replace(/\n$/, ""), true);
      return "skip";
    }
    if (node.tagName === "pre" && node.children.length === 1 && node.children[0]!.type === "element" && node.children[0]!.tagName === "code") {
      highlightFence(node.children[0]!);
      return "skip";
    }
    if (isMathCode(node)) {
      parent.children[index] = formula(textOf(node), classes(node).includes("math-display"));
      return "skip";
    }
    for (const [key, tags] of Object.entries(urlAttributes)) {
      if (Object.hasOwn(node.properties, key) && (tags === null || tags.includes(node.tagName))) {
        node.properties[key] = safeUrl(String(node.properties[key] ?? ""));
      }
    }
  });
  return { tree, formulas };
}
