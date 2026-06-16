// core/wikilink: strip [[wikilink]] markup from display text. The single home —
// bundles (assets/extensions), src/cli, and src/surface all import it.
// `[[path|alias]]` → alias; `[[path/to/page.md]]` → last segment (sans .md).
export function stripWikilinks(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => {
      const last = target.split("/").pop() ?? target;
      return last.endsWith(".md") ? last.slice(0, -3) : last;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the slug for each `[[wikilink]]` in `text`, preserving order and
 * deduplicating. Slug = last path segment of the target with `.md` stripped —
 * matching the normalization `stripWikilinks` applies for bare targets.
 * For `[[target|alias]]` the slug is derived from `target` (not the alias).
 */
export function wikilinkSlugs(text: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]!;
    const last = target.split("/").pop() ?? target;
    const slug = last.endsWith(".md") ? last.slice(0, -3) : last;
    if (!seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}
