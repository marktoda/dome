// dome.markdown.render-index — garden processor: compile the index catalog
// from per-page `description:` frontmatter. Deterministic, snapshot-in →
// patches-out (garden processors have no projection access; this reads
// frontmatter directly, the same posture as simplify-indexes). Index files
// are RENDERS: the processor rewrites the dome.markdown:index-catalog block
// in each file (preserving any human prose outside it) and retires shards
// that are no longer produced — splicing the block OUT when prose surrounds
// it, deleting only files that are nothing but our block and its rendered title
// (whitespace aside).
// Category shards render under meta/ (meta/index-entities.md); the root map
// index.md stays at the vault root. LEGACY root-level shards from before the
// meta/ move (index-entities.md) are retired on the first post-upgrade run.
// Pinned by NO_ACCRETING_REGISTRIES — nothing
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
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type ExtensionConfig,
  type ProcessorContext,
} from "../../../../src/core/processor";
import {
  INDEX_CATALOG_BLOCK,
  INDEX_CATALOG_OWNER,
  META_DIR,
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
/** Shared with simplify-indexes; dedup happens at the diagnostics sink. */
const ANOMALY_CODE = "dome.markdown.generated-block-anomaly";
/**
 * Generated shard names the retirement scan owns: the root map `index.md`,
 * current shards `meta/index-<category>.md` (+`-N` overflow), and LEGACY
 * root-level shards (`index-entities.md`) from before the meta/ move —
 * matched so the first post-upgrade run retires them. Anchored at ^ so
 * directory navigation pages (`wiki/entities/index.md`) never match.
 * Interpolating META_DIR is safe only because it is metachar-free.
 */
const SHARD_NAME_RE = new RegExp(`^(?:${META_DIR}/)?index(-[a-z0-9-]+)?\\.md$`);
/** Category names become `index-<category>.md` filenames and wikilinks. */
const CATEGORY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/**
 * The renderer's own shard title (`# Index — entities`, `# Index — entities
 * (2/3)`) sits OUTSIDE the generated block (see wrapBlock in
 * lib/index-render.ts), so a retired render's remainder is the bare title,
 * not empty. A title-only remainder is still entirely ours — delete, don't
 * leave a heading stub. Anything else outside the block is human prose and
 * survives via splice.
 */
const GENERATED_TITLE_RE = /^# Index(?: — [^\n]+)?$/;

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
      // Marker anomalies — half-open or smuggled markers — make `spliceInto`
      // refuse; surface each as an info diagnostic (simplify-indexes' posture)
      // so the damage is visible instead of a silent skip.
      if (existing !== null) {
        effects.push(...anomalyDiagnostics(ctx, file, existing));
      }
      const next = existing === null ? content : spliceInto(existing, content);
      if (next === null || next === existing) continue;
      changes.push({ kind: "write", path: file, content: next });
    }

    // Stale shards: a previously rendered index file no longer produced —
    // covers both the legacy root layout (index-entities.md) and the current
    // meta/ layout (meta/index-entities.md). Only files carrying our generated
    // block are ours (a human file that merely matches the name pattern is
    // never touched). When the file is nothing but our block and its rendered
    // title — whitespace aside — delete it; when human prose lives outside the
    // block, splice the block OUT instead so the prose survives.
    for (const path of markdownPaths) {
      if (!SHARD_NAME_RE.test(path) || path in rendered) continue;
      const existing = await ctx.snapshot.readFile(path);
      if (existing === null) continue;
      effects.push(...anomalyDiagnostics(ctx, path, existing));
      const scan = findGeneratedBlock(
        existing,
        INDEX_CATALOG_OWNER,
        INDEX_CATALOG_BLOCK,
      );
      if (scan.range === null) continue;
      const before = existing.slice(0, scan.range.start);
      const after = existing.slice(scan.range.end);
      const remainder = `${before}${after}`.trim();
      if (remainder.length === 0 || GENERATED_TITLE_RE.test(remainder)) {
        changes.push({ kind: "delete", path });
        continue;
      }
      const kept = [before.trimEnd(), after.trim()].filter(
        (part) => part.length > 0,
      );
      changes.push({ kind: "write", path, content: `${kept.join("\n\n")}\n` });
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

/**
 * Info diagnostics for marker anomalies (half-open, smuggled, orphan markers)
 * on an existing index file — the same visibility posture as simplify-indexes:
 * the splice/scan ignores anomalies by construction, but a refused or skipped
 * file must leave an auditable trace, never a silent drop.
 */
function anomalyDiagnostics(
  ctx: ProcessorContext,
  path: string,
  content: string,
): ReadonlyArray<Effect> {
  return generatedBlockAnomalyDiagnostics({
    content,
    path,
    code: ANOMALY_CODE,
    blocks: [{ owner: INDEX_CATALOG_OWNER, block: INDEX_CATALOG_BLOCK }],
    sourceRef: (refPath, range) => ctx.sourceRef(refPath, range),
  });
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
