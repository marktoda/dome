// dome.markdown shared frontmatter-key line lookup.
//
// Consolidates the byte-identical `frontmatterKeyLine` helper that was
// copy-pasted in dome.markdown.frontmatter-normalization and
// dome.markdown.stale-dates. Both anchor diagnostics / SourceRefs to the
// 1-indexed line a frontmatter key sits on, and both tolerate leading
// indentation before the key (`^\s*<key>\s*:`).
//
// NOTE: dome.markdown.supersession-shared keeps its own, intentionally
// stricter variant (`^<key>\s*:`, top-level keys only). The two regexes
// diverge on indented keys, so folding supersession in here would change its
// behavior — it is deliberately left separate.

/**
 * 1-indexed line of a frontmatter key, or null when the content has no
 * frontmatter block (does not start with `---`) or the key is absent before
 * the closing `---`/`...` delimiter. Leading indentation before the key is
 * tolerated.
 */
export function frontmatterKeyLine(content: string, key: string): number | null {
  if (!content.startsWith("---")) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---" || line.trim() === "...") return null;
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`).test(line)) return i + 1;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
