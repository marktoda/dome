// dome.markdown index renderer — pure functions from (entries, config) to the
// generated index-file contents. The catalog body of every file it produces
// lives inside a `dome.markdown:index-catalog` generated block, so owners can
// keep hand prose above/below the block and the splice-guard machinery owns
// the markers. Determinism is load-bearing: same entries → byte-identical
// output (the garden processor diffs against the snapshot to no-op).
//
// NO_ACCRETING_REGISTRIES: these files are renders, not registries — nothing
// ever appends to them; the renderer rewrites them whole from per-page
// `description:` frontmatter.

import { compareStrings } from "../../../../src/core/compare";
import { generatedBlockMarkers } from "../../../../src/core/generated-block";

export type IndexEntry = {
  /** Vault-relative .md path. */
  readonly path: string;
  /** Frontmatter description (trimmed) or null when the page has none. */
  readonly description: string | null;
  /** Shard key, e.g. "entities". */
  readonly category: string;
};

export type IndexRenderConfig = {
  /** Soft cap per shard file body, in characters. */
  readonly shardBudgetChars: number;
};

/** The generated block every rendered index file owns. */
export const INDEX_CATALOG_OWNER = "dome.markdown";
export const INDEX_CATALOG_BLOCK = "index-catalog";

const MARKERS = generatedBlockMarkers(INDEX_CATALOG_OWNER, INDEX_CATALOG_BLOCK);

type ShardSummary = {
  readonly category: string;
  readonly count: number;
  /** Shard page names without the `.md` suffix, in page order. */
  readonly shards: ReadonlyArray<string>;
};

/** Render all index files. Key = vault-relative filename, value = full content. */
export function renderIndexFiles(
  entries: ReadonlyArray<IndexEntry>,
  config: IndexRenderConfig,
): Record<string, string> {
  if (entries.length === 0) return {};

  const byCategory = new Map<string, IndexEntry[]>();
  for (const entry of [...entries].sort((a, b) => compareStrings(a.path, b.path))) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const files: Record<string, string> = {};
  const summaries: ShardSummary[] = [];

  for (const category of [...byCategory.keys()].sort(compareStrings)) {
    const categoryEntries = byCategory.get(category) ?? [];
    const lines = categoryEntries.map(entryLine);
    const pages = paginate(lines, config.shardBudgetChars);
    const shardNames = pages.map((_, i) =>
      i === 0 ? `index-${category}.md` : `index-${category}-${i + 1}.md`,
    );
    pages.forEach((pageLines, i) => {
      const name = shardNames[i] as string;
      const suffix = pages.length > 1 ? ` (${i + 1}/${pages.length})` : "";
      files[name] = wrapBlock(`# Index — ${category}${suffix}`, pageLines.join("\n"));
    });
    summaries.push({
      category,
      count: categoryEntries.length,
      shards: shardNames.map((name) => name.replace(/\.md$/, "")),
    });
  }

  const rootLines = summaries.map(
    (s) =>
      `- **${s.category}** (${s.count}) — ${s.shards
        .map((name) => `[[${name}]]`)
        .join(", ")}`,
  );
  files["index.md"] = wrapBlock(
    "# Index",
    [
      "Generated map of this vault's indexed pages. Descriptions live in each",
      "page's `description:` frontmatter; edit them there, never here.",
      "",
      ...rootLines,
    ].join("\n"),
  );
  return files;
}

function entryLine(entry: IndexEntry): string {
  const link = entry.path.replace(/\.md$/, "");
  return entry.description === null
    ? `- [[${link}]] — *(no description yet)*`
    : `- [[${link}]] — ${entry.description}`;
}

function paginate(
  lines: ReadonlyArray<string>,
  budget: number,
): ReadonlyArray<ReadonlyArray<string>> {
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > budget) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function wrapBlock(title: string, body: string): string {
  return `${title}\n\n${MARKERS.start}\n${body}\n${MARKERS.end}\n`;
}
