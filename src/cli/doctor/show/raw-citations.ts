// `--show raw-citations`: walks wiki pages; for each `sources:` frontmatter
// entry whose link points under raw/, accumulates (raw target -> [wiki page
// paths]). Sorts the output for stable diffs.

import type { Vault } from "../../../vault";
import { walkWikiPages } from "../internal/walk-wiki-pages";

export async function showRawCitations(vault: Vault): Promise<{ info: string[] }> {
  const info: string[] = [];

  const citations: Map<string, string[]> = new Map();
  for await (const { rel } of walkWikiPages(vault)) {
    const out = await vault.tools.readDocument({ path: rel });
    if (!out.result.ok) continue;
    const sources = out.result.value.frontmatter.sources;
    if (!Array.isArray(sources)) continue;
    for (const s of sources) {
      if (typeof s !== "string") continue;
      const m = s.match(/^\[\[(raw\/[^\]]+)\]\]$/);
      if (!m) continue;
      const target = m[1]!;
      const list = citations.get(target) ?? [];
      list.push(rel);
      citations.set(target, list);
    }
  }
  if (citations.size === 0) {
    info.push("raw-citation: (no wiki pages cite any raw/ source)");
  } else {
    for (const [target, citers] of [...citations.entries()].sort()) {
      info.push(`raw-citation: ${target} <- [${citers.sort().join(", ")}]`);
    }
  }

  return { info };
}
