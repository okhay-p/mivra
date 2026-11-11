import type { ComponentProps, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import { ScrollableText } from "./stepper.js";

/**
 * The paper card every learning artifact sits in (#93): a warm rule around it, a restrained shadow and no padding
 * of its own, so the ruled header, the body and the inset step footer each run edge to edge.
 */
export function ArtifactCard({ className, ...props }: ComponentProps<typeof Card>) {
  return <Card data-artifact-card="" className={cn("border-border-strong shadow-paper gap-0 py-0 whitespace-normal", className)} {...props} />;
}

/**
 * The ruled header: the artifact's kind as a small mono eyebrow, then its title. The kind is chrome, so it may wear the
 * brand colour; the teaching states inside stay neutral. `aside` sits at the far end on a wide card and wraps below on a narrow one.
 */
export function ArtifactHeader({ kind, kindId, aside, children }: { kind: ReactNode; kindId?: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div data-slot="artifact-header" className="flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-1 border-b px-4 py-3 sm:px-5">
      <span id={kindId} className="text-accent-foreground shrink-0 font-mono text-[0.6875rem] leading-snug font-medium tracking-[0.09em] uppercase">
        {kind}
      </span>
      {children}
      {aside && <span className="text-muted-foreground ml-auto font-mono text-[0.6875rem] leading-snug tracking-[0.09em] uppercase">{aside}</span>}
    </div>
  );
}

/** A stepped or drawn artifact's title, in the header. Its name comes from inside the box, which is itself named "Formula" when it scrolls. */
export function ArtifactTitle({ id, text }: { id: string; text: string }) {
  return (
    <h3 className="font-heading min-w-0 flex-[1_1_12rem] text-[1.0625rem] leading-snug font-medium">
      <ScrollableText>
        <span id={id}>
          <MathText text={text} mode="math" />
        </span>
      </ScrollableText>
    </h3>
  );
}

/** The padded body under the header. */
export function ArtifactBody({ className, ...props }: ComponentProps<typeof CardContent>) {
  return <CardContent className={cn("flex flex-col gap-3 px-4 py-4 sm:px-5 sm:py-5", className)} {...props} />;
}

/**
 * The letter beside an answer (A, B, C…). Decorative: the answer's own text is its name, so the letter is hidden from
 * screen readers and never part of what's submitted. Past Z it shows nothing rather than a symbol.
 */
export function OptionKey({ index }: { index: number }) {
  return (
    <span
      aria-hidden="true"
      className="border-border-strong text-muted-foreground grid size-6 shrink-0 place-items-center rounded-[6px] border font-mono text-[0.72rem] font-medium"
      data-testid="option-key"
    >
      {index < 26 ? String.fromCharCode(65 + index) : ""}
    </span>
  );
}
