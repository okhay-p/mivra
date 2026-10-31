import { z } from "zod";

/**
 * table v1: a truth table, relation matrix or other tabular working, optionally stepped through.
 *
 * State rules (renderers must follow them):
 * - `cells` persists: a changed cell keeps its new value on every later step.
 * - `highlight` does not persist: each step lists all of its own, and omitting it means that step has none.
 * The table's shape never changes, so every index can be checked against `rows` and `columns`.
 */

const MAX_COLUMNS = 16;
const MAX_ROWS = 64;
const MAX_STEPS = 100;

const Header = z.string().trim().min(1).max(80);
const CellValue = z.union([z.number(), z.boolean(), z.string().max(120)]);
const Index = z.number().int().nonnegative();

export const TableHighlight = z
  .object({
    row: Index.optional().describe("0-based data row. With no column, highlights the whole row."),
    column: Index.optional().describe("0-based data column. With no row, highlights the whole column. With both, highlights one cell."),
    tone: z
      .enum(["active", "done", "muted"])
      .optional()
      .describe("active = current focus, done = finished, muted = ruled out. Defaults to active. Where highlights overlap, the later one wins."),
  })
  .strict();

export const TableCellChange = z
  .object({
    row: Index.describe("0-based data row."),
    column: Index.describe("0-based data column."),
    value: CellValue.describe("The cell's value from this step on."),
  })
  .strict();

export const TableStep = z
  .object({
    explanation: z.string().trim().min(1).max(500).describe("What happens in this step, in one or two sentences."),
    highlight: z
      .array(TableHighlight)
      .max(32)
      .optional()
      .describe("All cells, rows and columns to highlight at this step. Not carried over from earlier steps."),
    cells: z
      .array(TableCellChange)
      .max(64)
      .optional()
      .describe('Cells this step fills in or changes. They keep the new value on later steps. To reveal working, start a cell as "" and set it here.'),
  })
  .strict();

export const TableSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    columns: z.array(Header).min(1).max(MAX_COLUMNS).describe("Column headers, one per data column. Don't include a header for rowHeaders."),
    rows: z
      .array(z.array(CellValue).min(1).max(MAX_COLUMNS))
      .min(1)
      .max(MAX_ROWS)
      .describe('Data rows, each with exactly one cell per column. A boolean shows as T or F; "" is a blank cell.'),
    rowHeaders: z.array(Header).max(MAX_ROWS).optional().describe("Optional label for each row, e.g. a relation matrix's elements. Exactly one per row."),
    steps: z.array(TableStep).min(1).max(MAX_STEPS).optional().describe("Omit for a static table. With steps, the learner steps through them."),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const rowCount = spec.rows.length;
    const columnCount = spec.columns.length;
    spec.rows.forEach((row, i) => {
      if (row.length !== columnCount) {
        ctx.addIssue({ code: "custom", path: ["rows", i], message: `row has ${row.length} cells but there are ${columnCount} columns` });
      }
    });
    if (spec.rowHeaders && spec.rowHeaders.length !== rowCount) {
      ctx.addIssue({ code: "custom", path: ["rowHeaders"], message: `${spec.rowHeaders.length} row headers for ${rowCount} rows` });
    }
    const checkRow = (row: number, path: (string | number)[]) => {
      if (row >= rowCount) ctx.addIssue({ code: "custom", path, message: `row ${row} is outside the table (${rowCount} rows)` });
    };
    const checkColumn = (column: number, path: (string | number)[]) => {
      if (column >= columnCount) ctx.addIssue({ code: "custom", path, message: `column ${column} is outside the table (${columnCount} columns)` });
    };
    spec.steps?.forEach((step, i) => {
      step.highlight?.forEach((h, j) => {
        const path = ["steps", i, "highlight", j];
        if (h.row === undefined && h.column === undefined) ctx.addIssue({ code: "custom", path, message: "a highlight needs a row, a column or both" });
        if (h.row !== undefined) checkRow(h.row, [...path, "row"]);
        if (h.column !== undefined) checkColumn(h.column, [...path, "column"]);
      });
      step.cells?.forEach((c, j) => {
        checkRow(c.row, ["steps", i, "cells", j, "row"]);
        checkColumn(c.column, ["steps", i, "cells", j, "column"]);
      });
    });
  });

export type TableSpec = z.infer<typeof TableSpec>;
export type TableStep = z.infer<typeof TableStep>;
