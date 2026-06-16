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
 * Shorten a one-line label to a visible width WITHOUT cutting mid-word.
 * Builds up to the budget, backs off to the last word boundary, and — when a
 * clause boundary (`:` or `—`) sits in the last ~40% of that head — cuts at the
 * clause instead. Appends the ellipsis. Returns the input unchanged when it
 * already fits. Call before paint(); operates on plain (uncolored) text.
 */
export function shortenLabel(text: string, width: number, unicode = true): string {
  if (visibleWidth(text) <= width) return text;
  const ell = unicode ? "…" : "...";
  const budget = Math.max(0, width - ell.length);
  let fit = "";
  for (const ch of text) {
    if (visibleWidth(fit + ch) > budget) break;
    fit += ch;
  }
  const lastSpace = fit.lastIndexOf(" ");
  let head = lastSpace > 0 ? fit.slice(0, lastSpace) : fit;
  const clauseIdx = Math.max(head.lastIndexOf(":"), head.lastIndexOf("—"));
  if (clauseIdx >= Math.floor(head.length * 0.6)) head = head.slice(0, clauseIdx + 1);
  return `${head.trimEnd()}${ell}`;
}

// Re-export from the canonical home so the presenter barrel and any
// existing callers that import from this module continue to work.
export { stripWikilinks } from "../../core/wikilink";

/**
 * Strip paired markdown emphasis markers from plain text for CLI display.
 * Removes `**bold**`, `__bold__`, `*italic*`, `_italic_` — only when the
 * markers are paired around non-space content. Conservative: does NOT strip
 * unpaired asterisks/underscores (e.g. `a*b`, `snake_case` left untouched).
 * Apply BEFORE paint() and BEFORE shortenLabel().
 */
export function stripEmphasis(text: string): string {
  // Double markers first (must precede single so `**x**` → `x` not `*x*` → `x*`).
  // Use [^*] for ** and [^_] for __ to prevent greedy cross-span matching.
  return text
    .replace(/\*\*([^*\s][^*]*?[^*\s]|[^*\s])\*\*/g, "$1")
    .replace(/__([^_\s][^_]*?[^_\s]|[^_\s])__/g, "$1")
    .replace(/\*([^*\s][^*]*?[^*\s]|[^*\s])\*/g, "$1")
    .replace(/_([^_\s][^_]*?[^_\s]|[^_\s])_/g, "$1");
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
