// dome.daily.normalize-task-syntax — normalize the cosmetic syntax of tasks.
//
// Garden-phase, deterministic, patch.auto. For every checkbox task line it
// applies safe casing/spacing-only rewrites (`- [X]` → `- [x]`, collapse the
// post-marker space run to one, trim trailing whitespace while preserving a
// trailing `^anchor`), leaving task semantics — `[ ]`/`[-]`/`[x]` — untouched.
// This keeps the markdown (the source of truth) tidy so identity, surfacing,
// and reconcile read a canonical line shape.
//
// It also carries the CAPTURED-TODAY HEADING REPAIR, for TODAY's daily only:
// duplicate `# Captured today`/`## Captured today` headings (the real-vault
// pre-D3 wart) are merged into the single owned section, preserving every
// task line + anchor, with one info diagnostic per repair. Same hygiene
// class — canonicalizing the SHAPE of task surfaces without changing task
// semantics — same triggers, same grant, so it lives here rather than in a
// fourth processor. Historical dailies are never touched (past notes stay
// append-only). Spec: [[wiki/specs/daily-surface]] §"Captured-today heading
// repair".
//
// Garden, not adoption: a capability-denied auto-patch in adoption is turned
// into a `severity:"block"` diagnostic that would refuse to advance the
// adopted ref (see apply-effect.ts). Running in garden means a narrow grant
// simply skips the normalization (no sub-proposal) instead of blocking the
// human's adoption. This mirrors dome.daily.stamp-block-id.
//
// The transformation is idempotent: a re-run over already-normalized content
// produces no changes, so the garden cascade converges at depth 1.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
  normalizeTaskSyntax,
  repairCapturedTodayHeadings,
} from "./daily-shared";

const normalizeTaskSyntaxProcessor = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const settings = dailyPathSettings(ctx.extensionConfig);
    const todayPath = dailyPath(localDateParts(ctx.now()), settings);
    const effects: Effect[] = [];
    const changes: FileChangeInput[] = [];
    const sourceRefs = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      // Captured-today heading repair — TODAY's daily only; historical
      // dailies and every other page are left exactly as written.
      let current = content;
      if (path === todayPath) {
        const repaired = repairCapturedTodayHeadings(current);
        if (repaired !== null) {
          current = repaired;
          effects.push(
            diagnosticEffect({
              severity: "info",
              code: "dome.daily.captured-heading-repair",
              message:
                `dome.daily: merged duplicate "Captured today" headings in ${path} ` +
                "into the single owned section (task lines and anchors preserved).",
              sourceRefs: [ctx.sourceRef(path, { startLine: 1, endLine: 1 })],
            }),
          );
        }
      }

      const normalized = normalizeTaskSyntax(current) ?? (current !== content ? current : null);
      if (normalized === null) continue;
      changes.push({ kind: "write", path, content: normalized });
      sourceRefs.push(ctx.sourceRef(path, { startLine: 1, endLine: 1 }));
    }
    if (changes.length === 0) return Object.freeze(effects);
    return Object.freeze([
      ...effects,
      patchEffect({
        mode: "auto",
        changes,
        reason:
          "normalize cosmetic task-line syntax (marker case, spacing, trailing whitespace) and repair captured-today headings",
        sourceRefs,
      }),
    ]);
  },
});

export default normalizeTaskSyntaxProcessor;
