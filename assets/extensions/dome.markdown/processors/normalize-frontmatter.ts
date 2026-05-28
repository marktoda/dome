// dome.markdown.normalize-frontmatter — Phase 12b adoption-phase processor.
//
// The first patch-emitting processor: normalizes YAML frontmatter on every
// changed markdown file by reordering keys into a canonical order. Keys
// missing from the input stay missing in the output — this processor does
// not invent fields, only reorders the ones already present.
//
// Per [[wiki/specs/processors]] §"Adoption phase":
//   - Deterministic: same input → same output (the key-order list and
//     gray-matter's YAML serializer are pure functions).
//   - Bounded cost: O(changed-files × frontmatter-size).
//   - No LLM, no network, no filesystem outside `ctx.snapshot`.
//
// Idempotency contract (load-bearing for the fixed-point adoption loop):
// applying the processor's emitted patch and then re-running the processor
// on the patched content MUST produce zero effects. Without that property,
// the adoption loop would diverge (iteration N+1 would emit a new patch
// every time). The contract is upheld by:
//   1. Reading the canonical key order from a module-level constant.
//   2. Round-tripping through gray-matter's parser + serializer, which is
//      a stable point under composition (parse∘stringify == identity for
//      already-normalized inputs).
// Test #6 in tests/extensions/normalize-frontmatter.test.ts verifies the
// contract explicitly: re-running on the processor's own output produces
// no further patches.
//
// Emits exactly one PatchEffect{mode: "auto"} per dispatch, carrying one
// FileChange{kind: "write"} per changed markdown file whose content
// differed after normalization. Files with no frontmatter, empty
// frontmatter, or malformed YAML are skipped silently — diagnostics for
// malformed YAML belong in a separate lint-frontmatter processor, not
// here. Skipping (rather than emitting a no-op patch) also keeps the
// PatchEffect's `changes` array non-empty, which `PatchEffectSchema`
// requires at the broker boundary.
//
// Per [[wiki/matrices/processor-phase-x-trigger]], adoption-phase
// processors may subscribe to `signal` triggers; we subscribe to
// `document.changed` (markdown body diffs) and `file.created` (covers
// newly-added paths whose `document.changed` may not fire if the file was
// added without a content diff — defensive, matches validate-wikilinks).
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader (the bundle is loaded via
// `loadBundles` in `src/extensions/loader.ts`). The `gray-matter`
// import resolves via Bun's node_modules lookup (gray-matter is already a
// runtime dep of @dome/sdk per package.json).

import matter from "gray-matter";

import {
  patchEffect,
  type Effect,
  type FileChange,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

// ----- Canonical key order --------------------------------------------------
//
// The seven keys that pin a stable position. Every other key the file
// happens to carry is appended after these, in alphabetical order. Keys
// not present in the input are NOT added to the output.
//
// Rationale for the order (matches the convention in the user's `~/vaults/`
// page format):
//   1. `type`     — the most diagnostic field: tells you what kind of page
//                   this is at a glance.
//   2. `id`       — stable identifier for cross-references.
//   3. `aliases`  — alternative names; reads naturally next to `id`.
//   4. `tags`     — categorical labels; close to `aliases` because both are
//                   short list-valued classifiers.
//   5. `created`  — provenance timestamps grouped at the end of the fixed
//   6. `updated`     section so the reader's eye lands on identity first.
//   7. `sources`  — citation list; trailing so long lists don't dominate.
const CANONICAL_ORDER: ReadonlyArray<string> = [
  "type",
  "id",
  "aliases",
  "tags",
  "created",
  "updated",
  "sources",
];

// ----- Processor ------------------------------------------------------------

const normalizeFrontmatter: Processor = defineProcessor({
  id: "dome.markdown.normalize-frontmatter",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
  ],
  capabilities: [
    { kind: "read", paths: ["**/*.md"] },
    { kind: "patch.auto", paths: ["**/*.md"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // `file.created` fires for every added path; we only care about
    // markdown bodies because that's the only file shape that carries
    // YAML frontmatter in the vault convention.
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));

    const changes: FileChange[] = [];
    const sourceRefs: SourceRef[] = [];

    for (const path of changedMarkdown) {
      const content = await ctx.snapshot.readFile(path);
      // `null` means the path was deleted in the candidate or never existed
      // there; either way there's nothing to normalize.
      if (content === null) continue;

      const normalized = normalizeContent(content);
      // `null` signals "no frontmatter or malformed YAML" — skip without
      // emitting either a patch or a diagnostic. A separate
      // `lint-frontmatter` processor is the right home for malformed-YAML
      // diagnostics; this processor's only job is normalization.
      if (normalized === null) continue;
      // Identical content means the frontmatter is already canonical;
      // emitting a no-op write would still produce a closure commit on
      // the candidate (the apply-patch path doesn't dedup at the change
      // level), so we elide it here. This also keeps the idempotency
      // contract direct: a second run on canonical content produces an
      // empty `changes` list → no PatchEffect → loop converges.
      if (normalized === content) continue;

      changes.push({ kind: "write", path, content: normalized });
      // Anchor the source ref at line 1 of the file — the frontmatter
      // always lives at the top, and the line range is informational
      // (the patch is whole-content, not a hunk). Matches the granularity
      // validate-wikilinks uses for non-position-specific findings.
      sourceRefs.push(ctx.sourceRef(path, { startLine: 1, endLine: 1 }));
    }

    // Empty `changes` → no PatchEffect: `PatchEffectSchema` rejects an
    // empty changes list at the broker boundary, and an empty PatchEffect
    // is semantically meaningless anyway.
    if (changes.length === 0) return [];

    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "normalize frontmatter key order",
        sourceRefs,
      }),
    ];
  },
});

export default normalizeFrontmatter;

// ----- internals ------------------------------------------------------------

/**
 * Normalize the frontmatter in `content`. Returns:
 *   - the normalized content string when the file had parseable, non-empty
 *     frontmatter (which may equal `content` if already canonical — the
 *     caller dedups);
 *   - `null` if the file has no frontmatter, empty frontmatter, or
 *     malformed YAML (the three "nothing to do" cases — collapsed into one
 *     return value because the processor's behavior is identical for all
 *     three: skip).
 *
 * The function is pure and synchronous — no I/O, no global state.
 */
function normalizeContent(content: string): string | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    // Malformed YAML — `js-yaml` (via gray-matter's default engine) throws
    // a `YAMLException`. Swallow it; this processor doesn't surface
    // diagnostics. A future `lint-frontmatter` processor will.
    return null;
  }

  // Two "nothing to do" cases collapse into the same null return:
  //   - `isEmpty: true`  — the file had `---\n---` delimiters with no
  //                        content between them (gray-matter sets this
  //                        explicitly).
  //   - `data` is `{}`   — there were no `---` delimiters at all
  //                        (gray-matter returns early in parseMatter
  //                        without ever populating `data` beyond the
  //                        default `{}` set by `to-file`).
  if (parsed.isEmpty || Object.keys(parsed.data).length === 0) {
    return null;
  }

  const reordered = reorderKeys(parsed.data);

  // Pass `parsed.content` (the body sans frontmatter) rather than the
  // original `content` to `matter.stringify`. If we passed the original
  // content, gray-matter would re-parse it and `Object.assign({},
  // file.data, data)` inside `stringify.js` would copy the ORIGINAL
  // (wrongly-ordered) keys first and then overlay the reordered data on
  // top — but `Object.assign` doesn't reorder existing keys, so the
  // serialized YAML would carry the original key order. Stripping the
  // frontmatter up-front by using `parsed.content` makes the merge a
  // no-op (the parsed file's data is `{}`), and the reordered object's
  // insertion order is preserved through to the YAML output.
  return matter.stringify(parsed.content, reordered);
}

/**
 * Build a new object whose keys are in canonical order. Keys present in
 * `CANONICAL_ORDER` come first in the listed order; remaining keys follow
 * in alphabetical order. Insertion order on the returned object is the
 * load-bearing surface — JavaScript guarantees property iteration follows
 * insertion order for string keys, and gray-matter's YAML serializer
 * iterates with `Object.keys` / `for..in`, so the output YAML key order
 * matches our insertion order.
 *
 * Keys not present in the input stay missing from the output: this
 * processor reorders, it does not invent.
 */
function reorderKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const remaining = new Set<string>(Object.keys(data));

  for (const key of CANONICAL_ORDER) {
    if (remaining.has(key)) {
      out[key] = data[key];
      remaining.delete(key);
    }
  }

  // Stable trailing order for any non-canonical keys the file happens to
  // carry. Alphabetical sort makes the output insensitive to the input's
  // key order (a second normalization pass produces the same trailing
  // order, regardless of how the upstream document happened to write
  // them) — that stability is what makes the idempotency contract hold.
  const trailing = [...remaining].sort();
  for (const key of trailing) {
    out[key] = data[key];
  }

  return out;
}
