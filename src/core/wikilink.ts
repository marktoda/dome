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
