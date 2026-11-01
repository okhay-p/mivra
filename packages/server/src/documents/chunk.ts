import type { ExtractedPage } from "./extract.js";

/** Small enough that a turn's budget can hold several pieces from different places. */
const MAX_CHUNK_CHARS = 1200;

/** Splits text at line ends where it can, and at spaces or mid-word where a line is too long. */
function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = window.lastIndexOf("\n") > max / 2 ? window.lastIndexOf("\n") : at > 0 ? at : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** A document's pages as ordered chunks that remember their page. */
export function chunkPages(pages: ExtractedPage[]): { page: number; seq: number; text: string }[] {
  let seq = 0;
  return pages.flatMap(({ page, text }) => splitText(text, MAX_CHUNK_CHARS).map((chunk) => ({ page, seq: seq++, text: chunk })));
}
