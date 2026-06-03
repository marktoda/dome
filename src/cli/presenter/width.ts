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
