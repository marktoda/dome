// src/cli/presenter/width.ts
import stringWidth from "string-width";

export function visibleWidth(text: string): number {
  return stringWidth(text);
}

export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const gap = width - visibleWidth(text);
  if (gap <= 0) return text;
  const fill = " ".repeat(gap);
  return align === "right" ? fill + text : text + fill;
}

/**
 * Truncate to a visible width, appending an ellipsis. `unicode` picks the
 * single-char "…" (true) vs "..." (false). Operates on plain (uncolored)
 * text — call before paint().
 */
export function truncate(text: string, width: number, unicode = true): string {
  if (visibleWidth(text) <= width) return text;
  const ell = unicode ? "…" : "...";
  const budget = Math.max(0, width - ell.length);
  let out = "";
  for (const ch of text) {
    if (visibleWidth(out + ch) > budget) break;
    out += ch;
  }
  return out + ell;
}

/**
 * Word-wrap plain (uncolored) text to a visible width. Words longer than
 * `width` get their own line rather than being split mid-word. Always
 * returns at least one line. Call before paint().
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (visibleWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}
