import "katex/dist/katex.min.css";
import { Component, memo, useDeferredValue, type ComponentProps, type ReactNode } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type Plugins = NonNullable<Options["remarkPlugins"]>;

interface MathTextProps {
  /** Markdown with `$...$` and `$$...$$` maths. May be half-written, while a reply streams. */
  text: string;
  /**
   * "block" (the default) renders paragraphs, lists, code, tables and display maths inside a `div`.
   * "inline" renders one `span` for titles, table cells and option text: only inline markdown and maths
   * count, so "1. Sort" stays as written, and links show as their text because a link can't sit in a button.
   */
  mode?: "block" | "inline";
  className?: string;
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
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

function inlineMathIn(node: MdNode, visit: (math: MdNode, parent: MdNode) => void) {
  for (const child of node.children ?? []) {
    if (child.type === "inlineMath") visit(child, node);
    inlineMathIn(child, visit);
  }
}

/** Each pass fixes one dollar per paragraph. A paragraph with more than this many plain dollars can keep a false formula. */
const MAX_DOLLAR_PASSES = 32;

function isPlainDollars(source: string, start: number, end: number) {
  const raw = source.slice(start, end);
  if (raw.startsWith("$$")) return false;
  return /^\$\s|\s\$$/.test(raw) || /\d/.test(source[end] ?? "");
}

/**
 * `$x$` is maths, so the parser also pairs up the dollars in "costs $5 and $10". This applies Pandoc's rule:
 * a `$...$` with whitespace just inside a delimiter, or a digit just after it, isn't maths, so its opening
 * dollar is escaped and the text parsed again. Only the first in a paragraph is escaped per pass, because
 * the pairs after it were made by counting that dollar. Going through the parser leaves code alone, and text
 * with no such dollars is only parsed once. "$5 or 6$" still reads as a formula.
 */
function dollarsToText(source: string, parse: (source: string) => MdNode) {
  let tree = parse(source);
  for (let pass = 0; pass < MAX_DOLLAR_PASSES; pass++) {
    const firstByParent = new Map<MdNode, number>();
    inlineMathIn(tree, (math, parent) => {
      const start = math.position?.start.offset;
      const end = math.position?.end.offset;
      if (start === undefined || end === undefined || firstByParent.has(parent)) return;
      if (isPlainDollars(source, start, end)) firstByParent.set(parent, start);
    });
    if (firstByParent.size === 0) break;
    for (const start of [...firstByParent.values()].sort((a, b) => b - a)) source = `${source.slice(0, start)}\\${source.slice(start)}`;
    tree = parse(source);
  }
  return { tree, source };
}

/** Replaces the parser, since only it can change the source. `display` makes a one-line `$$x$$` display maths, as it reads. */
function remarkDollars(this: { parser?: unknown }, { display }: { display: boolean }) {
  const parse = this.parser as (source: string, file: unknown) => MdNode;
  this.parser = (doc: unknown, file: unknown) => {
    const { tree, source } = dollarsToText(String(doc), (text) => parse(text, file));
    if (display) {
      inlineMathIn(tree, (node) => {
        const start = node.position?.start.offset;
        if (start !== undefined && source.startsWith("$$", start)) {
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ["language-math", "math-display"] } };
        }
      });
    }
    return tree;
  };
}

/** Turns off everything that makes a block, by the names micromark gives those constructs. */
function remarkInlineOnly(this: { data: () => { micromarkExtensions?: unknown[] } }) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({
    disable: {
      null: [
        "blockQuote",
        "codeFenced",
        "codeIndented",
        "definition",
        "gfmFootnoteDefinition",
        "headingAtx",
        "htmlFlow",
        "list",
        "mathFlow",
        "setextUnderline",
        "table",
        "thematicBreak",
      ],
    },
  });
}

const remarkPlugins = {
  block: [remarkGfm, remarkMath, [remarkDollars, { display: true }]] as unknown as Plugins,
  inline: [remarkGfm, remarkMath, remarkInlineOnly, [remarkDollars, { display: false }]] as unknown as Plugins,
};

// trust: false keeps \href and \includegraphics from producing anything active. rehype-katex shows invalid
// LaTeX as its source in errorColor rather than throwing. strict: "ignore" only silences console warnings.
const rehypePlugins: Options["rehypePlugins"] = [[rehypeKatex, { trust: false, strict: "ignore", errorColor: "var(--destructive)" }]];

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // A remote image would send data to whoever hosts it, so show its description instead.
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: (props: ComponentProps<"table">) => (
    <div className="math-text-scroll">
      <table>{props.children}</table>
    </div>
  ),
  // Below the card titles' level in the page outline as well as in size.
  h1: "h4",
  h2: "h4",
  h3: "h5",
  h4: "h6",
  h5: "h6",
};

const Rendered = memo(function Rendered({ text, mode }: { text: string; mode: "block" | "inline" }) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins[mode]}
      rehypePlugins={rehypePlugins}
      urlTransform={safeUrl}
      components={components}
      disallowedElements={mode === "inline" ? ["p", "a"] : undefined}
      unwrapDisallowed={mode === "inline"}
    >
      {text}
    </Markdown>
  );
});

/** Model text must never take the page down: if rendering it fails anyway, show it as plain text. */
class PlainTextOnError extends Component<{ text: string; children: ReactNode }, { failedText?: string }> {
  override state: { failedText?: string } = {};
  override componentDidCatch() {
    this.setState({ failedText: this.props.text });
  }
  override render() {
    return this.state.failedText === this.props.text ? this.props.text : this.props.children;
  }
}

/**
 * Renders model-written markdown and LaTeX safely: raw HTML shows as text, remote images as their alt text,
 * and only http, https and mailto links work. Long maths, code and tables scroll in their own box.
 */
export function MathText({ text, mode = "block", className }: MathTextProps) {
  // Keeps typing and scrolling responsive during a long reply: a render that falls behind skips to the latest delta.
  const deferred = useDeferredValue(text);
  const Root = mode === "inline" ? "span" : "div";
  return (
    <Root className={className ? `math-text ${className}` : "math-text"}>
      <PlainTextOnError text={deferred}>
        <Rendered text={deferred} mode={mode} />
      </PlainTextOnError>
    </Root>
  );
}
