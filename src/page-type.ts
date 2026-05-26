// Canonical wiki page type catalog.
// See docs/wiki/specs/sdk-surface.md §Document and docs/wiki/specs/page-schema.md.

export const WikiPageType = {
  Entity: "entity",
  Concept: "concept",
  Source: "source",
  Synthesis: "synthesis",
} as const;
export type WikiPageType = typeof WikiPageType[keyof typeof WikiPageType];

// Directory name (plural) -> singular page type. The directory name is the
// canonical truth. The four shipped types are listed first; English-irregular
// plurals for known extension types follow. Vault-defined extension types that
// want non-standard plurals will be declarable via a `plural:` field in
// page-types.yaml in v0.5.1; for v0.5 the regex fallback in pluralOf/singularOf
// covers regular cases and the `irregularPlurals` block below catches the rest.
export const WIKI_DIR_TO_TYPE = {
  entities: WikiPageType.Entity,
  concepts: WikiPageType.Concept,
  sources: WikiPageType.Source,
  syntheses: WikiPageType.Synthesis,
  // Irregular English plurals for substrate extension types this repo dogfoods.
  // Regular cases (e.g., gotchas -> gotcha, invariants -> invariant, specs -> spec)
  // are handled by the regex fallback in singularOf below.
  matrices: "matrix",
} as const;

export const WIKI_TYPE_TO_DIR = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  synthesis: "syntheses",
  matrix: "matrices",
} as const;

export function pluralOf(singular: string): string {
  return (WIKI_TYPE_TO_DIR as Record<string, string>)[singular]
    ?? (singular.endsWith("y") ? singular.slice(0, -1) + "ies" : singular + "s");
}

export function singularOf(plural: string): string {
  return (WIKI_DIR_TO_TYPE as Record<string, string>)[plural]
    ?? (plural.endsWith("ies") ? plural.slice(0, -3) + "y"
        : plural.endsWith("es") ? plural.slice(0, -2)
        : plural.endsWith("s") ? plural.slice(0, -1)
        : plural);
}
