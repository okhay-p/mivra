import katex from "katex";
import "katex/dist/katex.min.css";
import { Component, isValidElement, memo, useDeferredValue, useMemo, type ComponentProps, type ReactElement, type ReactNode } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { isTooDeep, remarkDollarRule, splitBlocks, splitMath } from "./math-syntax.js";

interface MathTextProps {
  /** The text. May be half-written, while a reply streams. */
  text: string;
  /**
   * What the text is allowed to mean. Choose by what a change of meaning would cost:
   *
   * - "math" is for artifact fields, and anything that may hold an answer or a structured value. Only `$...$`
   *   is a formula and `\$` a dollar; all else is literal, so the options `2*3*4` and `234` stay different.
   *   Renders a `span`, so it fits in a button or heading. Line breaks are kept.
   * - "block" (the default) is for explanatory prose, such as replies: GitHub-flavoured markdown with `$...$`
   *   and display `$$...$$` maths, inside a `div`. It can reformat what it shows, so `2*3*4` loses its stars.
   */
  mode?: "block" | "math";
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

/** Replaces the parser's verdict on a one-line `$$x$$`, which it calls inline, with the display maths it reads as. */
function remarkDisplayDollars() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: MdNode) => {
      for (const child of node.children ?? []) {
        const start = child.position?.start.offset;
        if (child.type === "inlineMath" && start !== undefined && source.startsWith("$$", start)) {
          child.data = { ...child.data, hProperties: { ...child.data?.hProperties, className: ["language-math", "math-display"] } };
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

const remarkPlugins = [remarkGfm, remarkMath, remarkDollarRule, remarkDisplayDollars] as unknown as NonNullable<Options["remarkPlugins"]>;

/**
 * One formula. Memoised, so a streaming paragraph doesn't typeset the same 100 formulas again per delta. KaTeX
 * escapes its input and, with trust: false, won't produce anything active (\href, \includegraphics), which is
 * why its HTML is safe to insert. Invalid LaTeX shows as its source in errorColor. strict: "ignore" only
 * silences console warnings.
 */
const Formula = memo(function Formula({ source, display }: { source: string; display: boolean }) {
  try {
    const html = katex.renderToString(source, { displayMode: display, trust: false, strict: "ignore", throwOnError: false, errorColor: "var(--destructive)" });
    return <span className="math-text-formula" dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span className="katex-error">{source}</span>;
  }
});

const isMath = (className: string | undefined) => className?.split(" ").includes("language-math") ?? false;

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  code: ({ className, children }) =>
    isMath(className) ? <Formula source={String(children)} display={className!.includes("math-display")} /> : <code className={className}>{children}</code>,
  // `$$` blocks and ```math fences arrive as a <pre> around the <code> above.
  pre: ({ children }) => {
    const code = isValidElement(children) ? (children as ReactElement<{ className?: string; children?: ReactNode }>) : undefined;
    return code && isMath(code.props.className) ? <Formula source={String(code.props.children).replace(/\n$/, "")} display /> : <pre>{children}</pre>;
  },
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

/** Model text must never take the page down: if rendering it fails anyway, show it as plain text. */
class PlainTextOnError extends Component<{ text: string; children: ReactNode }, { failedText?: string }> {
  override state: { failedText?: string } = {};
  override componentDidCatch() {
    this.setState({ failedText: this.props.text });
  }
  override render() {
    return this.state.failedText === this.props.text ? <p className="math-text-literal">{this.props.text}</p> : this.props.children;
  }
}

/** Memoised on its text, so only the block a delta touches is parsed again. */
const Block = memo(function Block({ text }: { text: string }) {
  if (isTooDeep(text)) return <p className="math-text-literal">{text}</p>;
  return (
    <PlainTextOnError text={text}>
      <Markdown remarkPlugins={remarkPlugins} urlTransform={safeUrl} components={components}>
        {text}
      </Markdown>
    </PlainTextOnError>
  );
});

function BlockText({ text, className }: { text: string; className: string }) {
  // Keeps typing and scrolling responsive during a long reply: a render that falls behind skips to the latest delta.
  const deferred = useDeferredValue(text);
  const blocks = useMemo(() => splitBlocks(deferred), [deferred]);
  return (
    <div className={className}>
      {blocks.map((block, i) => (
        <Block key={i} text={block} />
      ))}
    </div>
  );
}

function LiteralText({ text, className }: { text: string; className: string }) {
  const pieces = useMemo(() => splitMath(text), [text]);
  return (
    <span className={`${className} math-text-literal`}>
      {pieces.map((piece, i) => ("formula" in piece ? <Formula key={i} source={piece.formula} display={false} /> : piece.text))}
    </span>
  );
}

/**
 * Renders model-written text safely: raw HTML shows as text, remote images as their alt text, and only http,
 * https and mailto links work. Long maths, code and tables scroll in their own box. See `mode` for which to use.
 */
export function MathText({ text, mode = "block", className }: MathTextProps) {
  const classes = className ? `math-text ${className}` : "math-text";
  return mode === "math" ? <LiteralText text={text} className={classes} /> : <BlockText text={text} className={classes} />;
}
