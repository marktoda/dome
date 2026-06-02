// dome.markdown.normalize-frontmatter — Phase 12b adoption-phase processor.
//
// The first patch-emitting processor: normalizes YAML frontmatter on every
// changed markdown file by reordering keys into a canonical order. For
// managed `wiki/` pages it also refreshes an existing `updated:` field when
// the page's git lastChangedAt date has drifted. Keys missing from the
// input stay missing in the output — this processor does not invent fields.
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
//   2. Parsing with gray-matter, normalizing parser-coerced scalars such as
//      date-only timestamps, and serializing with `yaml` in a stable key order.
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

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { dateOnly } from "./frontmatter-dates";
import {
  parseFrontmatter,
  refreshUpdatedDate,
  reorderFrontmatterKeys,
  stringifyFrontmatter,
} from "./frontmatter-normalization";
import { frontmatterLintModeForPath } from "./path-policy";

// ----- Processor ------------------------------------------------------------

const normalizeFrontmatter: Processor = defineProcessor({
  id: "dome.markdown.normalize-frontmatter",
  version: "0.2.1",
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

    const changes: FileChangeInput[] = [];
    const sourceRefs: SourceRef[] = [];

    for (const path of changedMarkdown) {
      const content = await ctx.snapshot.readFile(path);
      // `null` means the path was deleted in the candidate or never existed
      // there; either way there's nothing to normalize.
      if (content === null) continue;

      const parsed = parseFrontmatter(content);
      // `null` signals "no frontmatter or malformed YAML" — skip without
      // emitting either a patch or a diagnostic. A separate
      // `lint-frontmatter` processor is the right home for malformed-YAML
      // diagnostics; this processor's only job is normalization.
      if (parsed === null) continue;

      const refreshedUpdated =
        shouldRefreshUpdated(ctx, path) && parsed.currentUpdatedDate !== null
          ? await lastChangedDate(ctx, path)
          : null;
      const normalized = stringifyFrontmatter(
        parsed.body,
        reorderFrontmatterKeys(
          refreshUpdatedDate(parsed.data, refreshedUpdated),
        ),
      );
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
        reason: "normalize frontmatter key order and managed dates",
        sourceRefs,
      }),
    ];
  },
});

export default normalizeFrontmatter;

// ----- internals ------------------------------------------------------------

async function lastChangedDate(
  ctx: ProcessorContext,
  path: string,
): Promise<string | null> {
  const info = await ctx.snapshot.getFileInfo(path);
  if (info === null) return null;
  return dateOnly(info.lastChangedAt);
}

function shouldRefreshUpdated(ctx: ProcessorContext, path: string): boolean {
  return (
    ctx.proposal !== null &&
    ctx.proposal.base !== ctx.proposal.head &&
    frontmatterLintModeForPath(path) === "required"
  );
}
