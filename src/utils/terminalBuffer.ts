// Pure helpers over xterm's buffer API (no xterm import, so tests can run in Node).

interface BufLine { isWrapped: boolean; translateToString(trimRight?: boolean): string }
export interface TermLike {
  buffer: { active: { baseY: number; cursorY: number; getLine(y: number): BufLine | undefined } };
}

/**
 * Text of the logical line under the cursor. `cursorY` is relative to the
 * viewport, so the absolute buffer row is `baseY + cursorY` (audit BUG-010 —
 * using cursorY alone read an old scrollback row once output had scrolled).
 * Long commands soft-wrap over several rows; walk back over wrapped rows and
 * join them.
 */
export function currentLogicalLine(term: TermLike): string {
  const buf = term.buffer.active;
  let row = buf.baseY + buf.cursorY;
  let line = buf.getLine(row);
  if (!line) return "";
  const parts = [line.translateToString(true)];
  while (line && line.isWrapped && row > 0) {
    row -= 1;
    line = buf.getLine(row);
    if (line) parts.unshift(line.translateToString(false));
  }
  // translateToString(true) trims trailing whitespace on the last row only
  return parts.join("");
}

