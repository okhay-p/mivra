import type { TableSpec, TableStep } from "@mivra/protocol";
import type { KeyboardEvent } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ScrollableText, STEP_TONES, StepperControls, useStepper, type StepTone } from "./stepper.js";

type Highlight = NonNullable<TableStep["highlight"]>[number];

const TONE_NAMES: Record<StepTone, string> = { active: "Highlighted", done: "Done", muted: "Ruled out" };

/**
 * What to draw at a step, following the spec's state rules: cell changes persist from every step so far;
 * highlights belong to that step only. A table without steps is just its rows.
 */
export function tableStateAt(spec: TableSpec, index: number) {
  const rows = spec.rows.map((row) => [...row]);
  for (const step of spec.steps?.slice(0, index + 1) ?? []) {
    for (const { row, column, value } of step.cells ?? []) {
      if (rows[row] && column < rows[row].length) rows[row][column] = value;
    }
  }
  const step = spec.steps?.[index];
  return { rows, explanation: step?.explanation, highlight: step?.highlight ?? [], changes: step?.cells ?? [] };
}

const cellText = (value: string | number | boolean) => (typeof value === "boolean" ? (value ? "T" : "F") : String(value));

/** One-based, as a person counts, with the two axes named. */
const position = ({ row, column }: Pick<Highlight, "row" | "column">) =>
  [row !== undefined && `row ${row + 1}`, column !== undefined && `column ${column + 1}`].filter(Boolean).join(", ");

// Cell and header text keeps to whole words: wrapping anywhere would squeeze a column to a letter per line, and the table scrolls instead.
const CELL_TEXT = "wrap-normal!";

export function TableArtifact({ view }: ArtifactProps<"table">) {
  const { spec } = view;
  const stepper = useStepper(spec.steps?.length ?? 1);
  const state = tableStateAt(spec, stepper.index);
  // The later highlight wins where they overlap, as the spec says.
  const toneOf = (match: (h: Highlight) => boolean): StepTone | undefined => {
    const highlight = state.highlight.findLast(match);
    return highlight && (highlight.tone ?? "active");
  };
  const stepped = spec.steps !== undefined;

  return (
    <Card
      role="region"
      aria-label={`Table: ${spec.title}`}
      className="whitespace-normal"
      {...(stepped ? { tabIndex: 0, onKeyDown: stepper.onKeyDown } : {})}
    >
      <CardHeader>
        <CardTitle className="font-heading text-base">
          <h3>
            <ScrollableText>
              <MathText text={spec.title} mode="math" />
            </ScrollableText>
          </h3>
        </CardTitle>
        <CardDescription>Table</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Focusable so a keyboard can scroll a wide table; its arrow keys scroll rather than step. */}
        <div
          className="overflow-x-auto"
          role="group"
          aria-label="Table contents, scrolls sideways"
          tabIndex={0}
          data-testid="table-scroll"
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
          }}
        >
          <table className="mx-auto border-collapse text-sm">
            <caption className="sr-only">
              <MathText text={spec.title} mode="math" />
            </caption>
            <thead>
              <tr>
                {spec.rowHeaders && <td className="border-b px-3 py-1.5" />}
                {spec.columns.map((column, c) => {
                  const tone = toneOf((h) => h.column === c && h.row === undefined);
                  return (
                    <th key={c} scope="col" className={cn("border-b px-3 py-1.5 text-center font-medium", tone && STEP_TONES[tone])}>
                      <MathText text={column} mode="math" className={CELL_TEXT} />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row, r) => {
                const headerTone = toneOf((h) => h.row === r && h.column === undefined);
                const header = spec.rowHeaders?.[r];
                return (
                  <tr key={r} className="border-b last:border-b-0">
                    {header !== undefined && (
                      <th scope="row" className={cn("border-r px-3 py-1.5 text-center font-medium", headerTone && STEP_TONES[headerTone])}>
                        <MathText text={header} mode="math" className={CELL_TEXT} />
                      </th>
                    )}
                    {row.map((value, c) => {
                      const tone = toneOf((h) => (h.row === undefined || h.row === r) && (h.column === undefined || h.column === c));
                      return (
                        <td key={c} className={cn("px-3 py-1.5 text-center tabular-nums", tone && STEP_TONES[tone])} data-tone={tone} data-testid="table-cell">
                          <MathText text={cellText(value)} mode="math" className={CELL_TEXT} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/*
          Always in the page and read whole, so each step is announced. Highlights are only colour, and a change
          only a new value in place, so screen readers get them in words here. The table stays outside it.
        */}
        {stepped && (
          <div aria-live="polite" aria-atomic="true" data-testid="table-live">
            <span className="sr-only">
              Step {stepper.index + 1} of {stepper.last + 1}.{" "}
            </span>
            <ScrollableText>
              <MathText text={state.explanation ?? ""} mode="math" />
            </ScrollableText>
            <span className="sr-only" data-testid="table-description">
              {state.highlight.map((h) => ` ${TONE_NAMES[h.tone ?? "active"]}: ${position(h)}.`)}
              {state.changes.map((c) => ` Changed ${position(c)} to ${cellText(c.value)}.`)}
            </span>
          </div>
        )}
        <StepperControls stepper={stepper} play announce={false} />
      </CardContent>
    </Card>
  );
}
