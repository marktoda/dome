// dome.daily.normalize-task-syntax — normalize the cosmetic syntax of tasks.
//
// Garden-phase, deterministic, patch.auto. For every checkbox task line it
// applies safe casing/spacing-only rewrites (`- [X]` → `- [x]`, collapse the
// post-marker space run to one, trim trailing whitespace while preserving a
// trailing `^anchor`), leaving task semantics — `[ ]`/`[-]`/`[x]` — untouched.
// This keeps the markdown (the source of truth) tidy so identity, surfacing,
// and reconcile read a canonical line shape.
//
// Garden, not adoption: a capability-denied auto-patch in adoption is turned
// into a `severity:"block"` diagnostic that would refuse to advance the
// adopted ref (see apply-effect.ts). Running in garden means a narrow grant
// simply skips the normalization (no sub-proposal) instead of blocking the
// human's adoption. This mirrors dome.daily.stamp-block-id.
//
// The transformation is idempotent: a re-run over already-normalized content
// produces no changes, so the garden cascade converges at depth 1.

import { patchEffect, type Effect, type FileChangeInput } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { normalizeTaskSyntax } from "./daily-shared";

const normalizeTaskSyntaxProcessor = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const changes: FileChangeInput[] = [];
    const sourceRefs = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const normalized = normalizeTaskSyntax(content);
      if (normalized === null) continue;
      changes.push({ kind: "write", path, content: normalized });
      sourceRefs.push(ctx.sourceRef(path, { startLine: 1, endLine: 1 }));
    }
    if (changes.length === 0) return [];
    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "normalize cosmetic task-line syntax (marker case, spacing, trailing whitespace)",
        sourceRefs,
      }),
    ];
  },
});

export default normalizeTaskSyntaxProcessor;
