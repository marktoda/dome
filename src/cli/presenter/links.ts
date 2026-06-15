// src/cli/presenter/links.ts
// Inline-link handling for human CLI output: extract markdown links from a
// label so the URL never consumes visible width or gets truncated, and render
// them as OSC 8 terminal hyperlinks when the terminal supports it.

import type { Caps } from "./caps";

export type InlineLink = { readonly label: string; readonly url: string };

// [label](url) — label has no newline/bracket; url has no whitespace or ')'.
// A leading '!' (image) is captured so we can skip it.
const MD_LINK_RE = /(!?)\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Split inline markdown links out of a display label. Returns the cleaned text
 * (links removed, dangling bullet/pipe separators and double spaces collapsed)
 * and the links in source order. Image links (`![…]`) are left in place.
 */
export function splitInlineLinks(text: string): {
  readonly text: string;
  readonly links: ReadonlyArray<InlineLink>;
} {
  const links: InlineLink[] = [];
  const stripped = text.replace(MD_LINK_RE, (match, bang: string, label: string, url: string) => {
    if (bang === "!") return match; // image — leave untouched
    links.push({ label, url });
    return "";
  });
  if (links.length === 0) return { text, links };
  const cleaned = stripped
    .replace(/\s{2,}/g, " ")              // collapse runs left by removal
    .replace(/\s*[·|]\s*$/g, "")          // trailing bullet/pipe separator
    .replace(/^\s*[·|]\s*/g, "")          // leading bullet/pipe separator
    .trim();
  return { text: cleaned, links };
}

const OSC8 = "\x1b]8;;";
const ST = "\x1b\\";

/**
 * Render `label` as an OSC 8 terminal hyperlink to `url` when the terminal
 * supports it (`caps.hyperlinks`), else return the bare `label`. The escape
 * sequence carries zero visible columns, so width math must use the label
 * width, not this string's length.
 */
export function hyperlink(label: string, url: string, caps: Caps): string {
  if (caps.hyperlinks !== true || url.length === 0) return label;
  return `${OSC8}${url}${ST}${label}${OSC8}${ST}`;
}
