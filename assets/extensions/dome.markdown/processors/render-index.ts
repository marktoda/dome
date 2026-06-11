// dome.markdown.render-index — garden processor: compile the index catalog
// from per-page `description:` frontmatter. Deterministic, snapshot-in →
// patches-out (garden processors have no projection access; this reads
// frontmatter directly, the same posture as simplify-indexes). Index files
// are RENDERS: the processor rewrites the dome.markdown:index-catalog block
// in each file (preserving any human prose outside it) and deletes shards
// that are no longer produced. Pinned by NO_ACCRETING_REGISTRIES — nothing
// ever appends to these files; every run rewrites them whole and diffs
// against the snapshot, so a matching catalog yields zero effects.

import matter from "gray-matter";

import { compareStrings } from "../../../../src/core/compare";
import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  findGeneratedBlock,
  generatedBlockMarkers,
  replaceGeneratedBlock,
} from "../../../../src/core/generated-block";
import {
  defineProcessorImplementation,
  type ExtensionConfig,
  type ProcessorContext,
} from "../../../../src/core/processor";
import {
  INDEX_CATALOG_BLOCK,
  INDEX_CATALOG_OWNER,
  renderIndexFiles,
  type IndexEntry,
} from "../lib/index-render";

// ----- Config resolution (degrade-not-crash, sweep.ts' idiom) ---------------

const DEFAULT_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  "wiki/entities/": "entities",
  "wiki/concepts/": "concepts",
  "wiki/syntheses/": "syntheses",
});
const DEFAULT_SHARD_BUDGET = 24_000;
const CONFIG_INVALID_CODE = "dome.markdown.render-index-config-invalid";
/** Root-level generated shard names: `index.md`, `index-entities.md`, `index-entities-2.md`. */
const SHARD_NAME_RE = /^index(-[a-z0-9-]+)?\.md$/;
/** Category names become `index-<category>.md` filenames and wikilinks. */
const CATEGORY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

type CategoriesResolution = {
  /** Path-prefix → category name. */
  readonly value: Readonly<Record<string, string>>;
  readonly problem: string | null;
};

function categoriesFromConfig(config?: ExtensionConfig): CategoriesResolution {
  const raw = config?.["index_categories"];
  if (raw === undefined) {
    return Object.freeze({ value: DEFAULT_CATEGORIES, problem: null });
  }
  // An explicitly empty map is a deliberate "rendering disabled" switch for
  // vaults whose indexes are curated by hand — honored as-is, never degraded
  // to defaults and never warned about.
  const valid =
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.entries(raw).every(
      ([prefix, category]) =>
        typeof prefix === "string" &&
        prefix.length > 0 &&
        prefix.trim() === prefix &&
        !prefix.startsWith("/") &&
        !prefix.includes("\\") &&
        !prefix.includes("..") &&
        typeof category === "string" &&
        CATEGORY_NAME_RE.test(category),
    );
  if (!valid) {
    return Object.freeze({
      value: DEFAULT_CATEGORIES,
      problem:
        "dome.markdown config index_categories must map relative path prefixes " +
        "to slug category names; falling back to " +
        Object.keys(DEFAULT_CATEGORIES).join(", "),
    });
  }
  return Object.freeze({
    value: Object.freeze({ ...(raw as Record<string, string>) }),
    problem: null,
  });
}

type BudgetResolution = {
  readonly value: number;
  readonly problem: string | null;
};

function budgetFromConfig(config?: ExtensionConfig): BudgetResolution {
  const raw = config?.["index_shard_budget_chars"];
  if (raw === undefined) {
    return Object.freeze({ value: DEFAULT_SHARD_BUDGET, problem: null });
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return Object.freeze({
      value: DEFAULT_SHARD_BUDGET,
      problem:
        "dome.markdown config index_shard_budget_chars must be a positive " +
        `integer; falling back to ${DEFAULT_SHARD_BUDGET}`,
    });
  }
  return Object.freeze({ value: raw, problem: null });
}

// ----- Processor -------------------------------------------------------------

const renderIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const categories = categoriesFromConfig(ctx.extensionConfig);
    // Explicitly empty `index_categories: {}` disables rendering outright:
    // zero categories → zero effects (defaults are never empty, so an empty
    // resolved map can only come from a deliberate opt-out).
    if (Object.keys(categories.value).length === 0) return Object.freeze([]);
    const budget = budgetFromConfig(ctx.extensionConfig);

    const effects: Effect[] = [];
    for (const problem of [categories.problem, budget.problem]) {
      if (problem === null) continue;
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: CONFIG_INVALID_CODE,
          message: problem,
          sourceRefs: [ctx.sourceRef("index.md", { startLine: 1, endLine: 1 })],
        }),
      );
    }

    const markdownPaths = [...(await ctx.snapshot.listMarkdownFiles())].sort(
      compareStrings,
    );

    const entries: IndexEntry[] = [];
    for (const path of markdownPaths) {
      const category = categoryFor(path, categories.value);
      if (category === null) continue;
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const fm = safeFrontmatter(content);
      if (fm["index"] === false) continue; // declarative opt-out
      const rawDescription = fm["description"];
      const description =
        typeof rawDescription === "string" && rawDescription.trim().length > 0
          ? rawDescription.trim()
          : null;
      entries.push({ path, description, category });
    }

    const rendered = renderIndexFiles(entries, { shardBudgetChars: budget.value });
    const changes: FileChangeInput[] = [];

    for (const [file, content] of Object.entries(rendered)) {
      const existing = await ctx.snapshot.readFile(file);
      const next = existing === null ? content : spliceInto(existing, content);
      if (next === null || next === existing) continue;
      changes.push({ kind: "write", path: file, content: next });
    }

    // Stale shards: a previously rendered root-level index file no longer
    // produced → delete, but only when it carries our generated block (a
    // human file that merely matches the name pattern is never ours).
    for (const path of markdownPaths) {
      if (!SHARD_NAME_RE.test(path) || path in rendered) continue;
      const existing = await ctx.snapshot.readFile(path);
      if (existing === null) continue;
      const scan = findGeneratedBlock(
        existing,
        INDEX_CATALOG_OWNER,
        INDEX_CATALOG_BLOCK,
      );
      if (scan.range === null) continue;
      changes.push({ kind: "delete", path });
    }

    if (changes.length === 0) return Object.freeze(effects);
    changes.sort((a, b) => compareStrings(String(a.path), String(b.path)));
    const categoryCount = new Set(entries.map((entry) => entry.category)).size;
    return Object.freeze([
      ...effects,
      patchEffect({
        mode: "auto",
        changes,
        reason:
          "dome.markdown: render index catalog — " +
          `${entries.length} pages across ${categoryCount} categories`,
        sourceRefs: changes.map((change) =>
          ctx.sourceRef(String(change.path), { startLine: 1, endLine: 1 }),
        ),
      }),
    ]);
  },
});

export default renderIndex;

// ----- Helpers ----------------------------------------------------------------

/** First matching prefix wins (longest first, so overlapping prefixes nest). */
function categoryFor(
  path: string,
  categories: Readonly<Record<string, string>>,
): string | null {
  // Directory index pages (`wiki/entities/index.md`) are navigation owned by
  // simplify-indexes, not content — never catalog entries.
  if (path.endsWith("/index.md")) return null;
  const prefixes = Object.keys(categories).sort(
    (a, b) => b.length - a.length || compareStrings(a, b),
  );
  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) return categories[prefix] ?? null;
  }
  return null;
}

function safeFrontmatter(content: string): Readonly<Record<string, unknown>> {
  try {
    return matter(content).data as Record<string, unknown>;
  } catch {
    // Malformed frontmatter never breaks catalog rendering; the page simply
    // contributes no description and no opt-out.
    return {};
  }
}

/**
 * Replace our block inside an existing file, preserving human prose around
 * it. Returns null (refuse to touch the page) when marker text appears
 * without a line-anchored pair — half-open or smuggled markers mean the page
 * needs a human, the same refusal posture as simplify-indexes.
 */
function spliceInto(existing: string, renderedWhole: string): string | null {
  const renderedScan = findGeneratedBlock(
    renderedWhole,
    INDEX_CATALOG_OWNER,
    INDEX_CATALOG_BLOCK,
  );
  if (renderedScan.range === null) return renderedWhole;
  const block = renderedWhole.slice(
    renderedScan.range.start,
    renderedScan.range.end,
  );
  const replaced = replaceGeneratedBlock(
    existing,
    INDEX_CATALOG_OWNER,
    INDEX_CATALOG_BLOCK,
    block,
  );
  if (replaced !== null) return replaced;
  const markers = generatedBlockMarkers(INDEX_CATALOG_OWNER, INDEX_CATALOG_BLOCK);
  if (existing.includes(markers.start) || existing.includes(markers.end)) {
    return null;
  }
  // File exists but carries no trace of our block → it predates the catalog
  // (or was hand-seeded); take it over whole.
  return renderedWhole;
}
