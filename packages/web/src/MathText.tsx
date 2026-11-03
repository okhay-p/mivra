import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import "katex/dist/katex.min.css";
import { Component, createContext, Fragment, memo, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { createSyncRenderer, createWorkerRenderer, type BlockRenderer, type BlockResult } from "./block-renderer.js";
import { blockSections, isTooDeep, replyBlocks, splitMath, type ReplyBlock } from "./math-syntax.js";
import { clearFormulaCache, typeset, type RenderedBlock } from "./render-markdown.js";

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

/** One formula in math mode. Memoised, and typeset results are cached, so streaming doesn't typeset it again. */
const Formula = memo(function Formula({ source, display }: { source: string; display: boolean }) {
  const html = typeset(source, display);
  return html === undefined ? <span className="katex-error">{source}</span> : <span className="math-text-formula" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A rendered block as React elements. Formulas come as an index into the block's typeset HTML. */
function RenderedTree({ block }: { block: RenderedBlock }) {
  return useMemo(() => {
    const components: Components = {
      a: ({ href, children }) =>
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        ),
      span: (props: ComponentProps<"span"> & { "data-formula"?: number }) => {
        const index = props["data-formula"];
        if (index === undefined) return <span className={props.className}>{props.children}</span>;
        return <span className="math-text-formula" dangerouslySetInnerHTML={{ __html: block.formulas[Number(index)] ?? "" }} />;
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
    return toJsxRuntime(block.tree, { Fragment, jsx, jsxs, components, passKeys: true, ignoreInvalidStyle: true });
  }, [block]);
}

/** A block as plain text. Code keeps its box, so it still scrolls instead of wrapping. */
function PlainBlock({ text }: { text: string }) {
  return blockSections(text).map((section, i) =>
    section.kind === "code" ? (
      <pre key={i}>
        <code>{section.code}</code>
      </pre>
    ) : (
      <p key={i} className="math-text-literal">
        {section.text}
      </p>
    ),
  );
}

/** Model text must never take the page down: if rendering it fails anyway, show it as plain text. */
class PlainTextOnError extends Component<{ text: string; children: ReactNode }, { failedText?: string }> {
  override state: { failedText?: string } = {};
  override componentDidCatch() {
    this.setState({ failedText: this.props.text });
  }
  override render() {
    return this.state.failedText === this.props.text ? <PlainBlock text={this.props.text} /> : this.props.children;
  }
}

let defaultRenderer: BlockRenderer | undefined;

/** One worker for the page, started when a block first needs it. Without workers, everything renders in place. */
function getDefaultRenderer(): BlockRenderer {
  defaultRenderer ??=
    typeof Worker === "undefined"
      ? createSyncRenderer()
      : createWorkerRenderer(() => new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module", name: "mivra-render" }));
  return defaultRenderer;
}

/** Forgets every rendered block and formula, and stops the worker. For tests. */
export function resetBlockRendering() {
  defaultRenderer?.dispose();
  defaultRenderer = undefined;
  clearFormulaCache();
}

/** Overrides where blocks render. For tests. */
export const BlockRendererContext = createContext<BlockRenderer | undefined>(undefined);

/**
 * The block's rendering, or the last one this block showed while a newer one is on its way, so a streaming block
 * doesn't flash back to plain text with each delta. Leaving the text, or the page, cancels the render.
 */
function useBlockResult(text: string | undefined): BlockResult | undefined {
  const renderer = useContext(BlockRendererContext) ?? getDefaultRenderer();
  const ready = text === undefined ? undefined : renderer.peek(text);
  const [arrived, setArrived] = useState<{ text: string; result: BlockResult }>();
  const shown = useRef<BlockResult>(undefined);
  useEffect(() => {
    if (text === undefined || ready !== undefined) return;
    const controller = new AbortController();
    void renderer.render(text, controller.signal).then((result) => {
      if (result !== undefined) setArrived({ text, result });
    });
    return () => controller.abort();
  }, [renderer, text, ready]);
  const current = ready ?? (arrived && arrived.text === text ? arrived.result : undefined);
  useEffect(() => {
    if (current !== undefined) shown.current = current;
  });
  return text === undefined ? undefined : (current ?? shown.current);
}

/**
 * Memoised on its text, so only the block a delta touches is parsed again. `source` is the block as the reply wrote
 * it, before display fences were separated, which is what plain text shows.
 */
const Block = memo(function Block({ text, source }: { text: string; source: string }) {
  const tooDeep = useMemo(() => isTooDeep(text), [text]);
  const result = useBlockResult(tooDeep ? undefined : text);
  // Until its first rendering arrives, if it timed out, or if it's too deep to try, a block shows as plain text.
  if (tooDeep || result === undefined || result === "plain") return <PlainBlock text={source} />;
  return (
    <PlainTextOnError text={source}>
      <RenderedTree block={result} />
    </PlainTextOnError>
  );
});

// A long reply mounts this many characters of blocks at a time, yielding between them, so that showing it can't
// hold the page for long. Ordinary replies fit in the first batch.
const MOUNT_BATCH_CHARS = 20_000;

/** How many of the blocks start within the first `chars` characters. Always at least one. */
function blocksWithin(blocks: ReplyBlock[], chars: number): number {
  let offset = 0;
  let count = 0;
  while (count < blocks.length && (count === 0 || offset < chars)) offset += blocks[count++]!.text.length;
  return count;
}

function BlockText({ text, className }: { text: string; className: string }) {
  // Keeps typing and scrolling responsive during a long reply: a render that falls behind skips to the latest delta.
  const deferred = useDeferredValue(text);
  const blocks = useMemo(() => replyBlocks(deferred), [deferred]);
  const [budget, setBudget] = useState(MOUNT_BATCH_CHARS);
  const mounted = blocksWithin(blocks, budget);
  useEffect(() => {
    if (mounted >= blocks.length) return;
    const timer = setTimeout(() => setBudget((chars) => chars + MOUNT_BATCH_CHARS), 0);
    return () => clearTimeout(timer);
  }, [mounted, blocks.length]);
  return (
    <div className={className}>
      {blocks.slice(0, mounted).map((block, i) => (
        <Block key={i} text={block.text} source={block.source} />
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
