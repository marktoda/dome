import type { WikiLink } from "./types";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Parse wikilinks from a markdown body. Wikilinks inside fenced code blocks
 * (``` ... ```) or inline code (`...`) are skipped — per CommonMark, code is
 * literal text and `[[wiki/x]]` appearing inside it is an example, not a link.
 * This matches what Obsidian and other editors do.
 */
export function parseWikilinks(body: string): WikiLink[] {
  const stripped = stripCodeRegions(body);
  const links: WikiLink[] = [];
  for (const match of stripped.matchAll(WIKILINK_RE)) {
    const raw = match[0]!;
    const target = match[1]!.trim();
    links.push({
      raw,
      target,
      isFullPath: isFullPathLink(target),
    });
  }
  return links;
}

/**
 * Replace fenced code blocks and inline code spans with whitespace of the
 * same length. Length-preserving so position-sensitive callers (none today,
 * but future-proof) get correct offsets.
 */
function stripCodeRegions(body: string): string {
  // Fenced code blocks: ``` ... ``` or ~~~ ... ~~~ (line-anchored fences).
  let out = body.replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, m => " ".repeat(m.length));
  // Inline code: single or multiple backticks (`...` or ``...``). Non-greedy.
  out = out.replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, m => " ".repeat(m.length));
  return out;
}

// Names of vault-root markdown files that are valid wikilink targets even
// though they contain no slash. Per docs/wiki/specs/vault-layout.md, the
// vault-root surface for user-authored files is small and stable (VISION,
// README); they're addressed by their bare uppercase name.
const ROOT_LEVEL_LINK_TARGETS: ReadonlyArray<string> = ["VISION", "README", "CLAUDE", "CHANGELOG", "LICENSE"];

/**
 * A wikilink is full-path iff it resolves to a vault-relative path:
 *   - `wiki/<...>`, `raw/<...>`, `notes/<...>`, `inbox/<...>` — the four typed surfaces
 *   - `cohesive/<...>` and other vault-root subdirectories (tolerated as `external` per vault-layout.md)
 *   - A known vault-root markdown file: `VISION`, `README`, `CLAUDE`, `CHANGELOG`, `LICENSE`
 *
 * Short-form links like `[[Danny]]` (no slash, not a root file) remain non-full-path.
 */
export function isFullPathLink(target: string): boolean {
  if (target.includes("/")) return true;
  return ROOT_LEVEL_LINK_TARGETS.includes(target);
}

export function suggestFullPath(short: string): string {
  const slug = short.toLowerCase().replace(/\s+/g, "-");
  return `wiki/entities/${slug}`;
}
