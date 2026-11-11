import { cn } from "@/lib/utils";

/**
 * Shared class names for the landing page's paper look on whole screens (#93, #94): side sheets drawn as a card
 * with a ruled header, small mono section labels, and segmented controls. Colours come from the theme tokens.
 */

/** A small uppercase mono label over a section, list or figure. */
export const EYEBROW = "text-muted-foreground font-mono text-[0.6875rem] leading-snug font-medium tracking-[0.09em] uppercase";

/** A side sheet on the card surface. */
export const PAPER_SHEET = "bg-card gap-0";
/** The sheet's ruled header. */
export const PAPER_SHEET_HEADER = "border-b px-5 py-4";
/** The sheet's serif title. */
export const PAPER_SHEET_TITLE = "font-heading text-[1.35rem] leading-tight font-medium tracking-[-0.015em]";

/** A row of mutually exclusive choices drawn as one sunken track. */
export const SEGMENTED = "bg-sunken inline-flex max-w-full flex-wrap gap-0.5 self-start rounded-lg border p-0.5";
/** One choice in a segmented track: the chosen one is lifted onto the card. */
export const segment = (selected: boolean) =>
  cn(
    "h-7 rounded-md px-2.5 text-[0.8125rem] font-medium hover:bg-transparent dark:hover:bg-transparent",
    selected ? "bg-card text-foreground hover:bg-card dark:hover:bg-card shadow-xs" : "text-muted-foreground hover:text-foreground",
  );
