import { codeLines, type TraceCode } from "@mivra/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * A trace's source code as inert text, numbered from 1, with the current step's lines highlighted. Nothing is
 * parsed or coloured, so no model text becomes markup. Long lines scroll inside the pane, which is a tab stop only
 * while it overflows; its arrow keys then scroll rather than step, like the trace's other scrolling boxes.
 */
export function CodePane({ code, lines }: { code: TraceCode; lines: readonly number[] }) {
  const source = codeLines(code.source);
  const current = new Set(lines);
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [focused, setFocused] = useState(false);
  const measure = () => {
    if (box.current) setOverflows(box.current.scrollWidth > box.current.clientWidth);
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(box.current!);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex min-w-0 flex-col rounded-md border" data-testid="code-pane">
      <div className="text-muted-foreground border-b px-3 py-1 font-mono text-xs" aria-hidden="true">
        {code.language}
      </div>
      <div
        ref={box}
        role="region"
        aria-label={`Code, ${code.language}${overflows ? ", scrolls sideways" : ""}`}
        className="min-w-0 overflow-x-auto py-2"
        data-testid="code-scroll"
        tabIndex={overflows ? 0 : focused ? -1 : undefined}
        onFocus={() => setFocused(true)}
        onBlur={(e) => setFocused(document.activeElement === e.currentTarget)}
        onKeyDown={(e: KeyboardEvent) => {
          if (overflows && (e.key === "ArrowLeft" || e.key === "ArrowRight")) e.stopPropagation();
        }}
      >
        <pre className="w-max min-w-full font-mono text-xs leading-relaxed [tab-size:4]">
          <code>
            {source.map((text, i) => {
              const active = current.has(i + 1);
              return (
                <span
                  key={i}
                  className={cn("flex border-l-2 pr-3", active ? "bg-muted border-foreground text-foreground" : "border-transparent")}
                  data-testid="code-line"
                  data-active={active || undefined}
                  aria-current={active ? "true" : undefined}
                >
                  <span className="text-muted-foreground w-9 shrink-0 pr-3 text-right select-none">{i + 1}</span>
                  {/* An empty line still takes its height. */}
                  <span className="whitespace-pre">{text || " "}</span>
                  {active && <span className="sr-only"> (current line)</span>}
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
