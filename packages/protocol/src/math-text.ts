const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";

export type MathPiece = { text: string } | { formula: string };

/** For math mode: everything is literal except `$...$` formulas, and `\$`, which is a literal dollar. */
export function splitMath(source: string): MathPiece[] {
  const pieces: MathPiece[] = [];
  let literal = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\" && source[i + 1] === "$") {
      literal += "$";
      i += 2;
    } else if (char !== "$") {
      literal += char;
      i += 1;
    } else if (source[i + 1] === "$") {
      // A dollar next to another is never a delimiter here, so "$$x$$" stays as written.
      while (source[i] === "$") {
        literal += "$";
        i += 1;
      }
    } else {
      const close = closingDollar(source, i);
      if (close === undefined) {
        literal += "$";
        i += 1;
      } else {
        if (literal) pieces.push({ text: literal });
        literal = "";
        pieces.push({ formula: source.slice(i + 1, close) });
        i = close + 1;
      }
    }
  }
  if (literal) pieces.push({ text: literal });
  return pieces;
}

function closingDollar(source: string, open: number): number | undefined {
  let close = open + 1;
  while (close < source.length && source[close] !== "$") {
    close += source[close] === "\\" && (source[close + 1] === "$" || source[close + 1] === "\\") ? 2 : 1;
  }
  if (close >= source.length || close === open + 1 || source[close + 1] === "$") return undefined;
  if (isSpace(source[open + 1]) || isSpace(source[close - 1]) || isDigit(source[close + 1])) return undefined;
  return /`|\n\s*\n/.test(source.slice(open, close)) ? undefined : close;
}
