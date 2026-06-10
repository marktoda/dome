// core/generated-block-diagnostics: surface scanner anomalies as diagnostics.
//
// The line-anchored scanner in `src/core/generated-block` reports anomalies
// (extra-start / extra-end / orphan-end / unterminated) alongside the winning
// pair — smuggled duplicate pairs, half-open blocks, prose-level marker
// damage. The splice primitives are immune to them by construction (first
// line-anchored pair wins), so the anomalies are inert; but inert is not the
// same as invisible. Splice call sites that process model-derived or human
// content turn each anomaly into one **info-severity** DiagnosticEffect so a
// smuggle ATTEMPT or a hand-mangled marker leaves an auditable trace without
// ever blocking adoption.
//
// Idempotency rides the established diagnostic dedup at the projection sink
// (`UNIQUE (processor_id, code, proposal_id, subject_hash)` in
// `src/projections/diagnostics.ts`): the sourceRef pins the anomalous marker
// line, so re-emission of the same anomaly at the same location dedupes and
// a new anomaly at a new line inserts a fresh row.
//
// Pure data work — no filesystem, git, or sqlite. Same module class as the
// grammar primitive itself; bundles import this next to their existing
// `core/generated-block` import (the splice-guard linter keeps the grammar
// single-implementation; this module consumes the scanner, it does not
// reimplement it).

import { diagnosticEffect, type DiagnosticEffect } from "./effect";
import {
  findGeneratedBlock,
  type GeneratedBlockAnomaly,
} from "./generated-block";
import type { SourceRef, TextRange } from "./source-ref";

/** One `(owner, block)` pair to scan for anomalies. */
export type GeneratedBlockAnomalyScanTarget = {
  readonly owner: string;
  readonly block: string;
};

/**
 * Scan `content` for marker anomalies across `blocks` and render one
 * info-severity DiagnosticEffect per anomaly. `code` is the emitting
 * bundle's stable diagnostic code (`dome.<bundle>.generated-block-anomaly`);
 * `sourceRef` is the processor's scoped `ctx.sourceRef` helper and anchors
 * each diagnostic at the anomalous marker line of `path`.
 *
 * Info severity by design: anomalies never block adoption — the splice
 * already ignored them (first line-anchored pair wins); the diagnostic only
 * makes the attempt visible.
 */
export function generatedBlockAnomalyDiagnostics(input: {
  readonly content: string;
  readonly path: string;
  readonly code: string;
  readonly blocks: ReadonlyArray<GeneratedBlockAnomalyScanTarget>;
  readonly sourceRef: (path: string, range?: TextRange) => SourceRef;
}): ReadonlyArray<DiagnosticEffect> {
  const out: DiagnosticEffect[] = [];
  for (const target of input.blocks) {
    const { anomalies } = findGeneratedBlock(
      input.content,
      target.owner,
      target.block,
    );
    for (const anomaly of anomalies) {
      out.push(
        diagnosticEffect({
          severity: "info",
          code: input.code,
          message: anomalyMessage({ target, anomaly, path: input.path }),
          sourceRefs: [
            input.sourceRef(input.path, {
              startLine: anomaly.line,
              endLine: anomaly.line,
            }),
          ],
        }),
      );
    }
  }
  return Object.freeze(out);
}

function anomalyMessage(input: {
  readonly target: GeneratedBlockAnomalyScanTarget;
  readonly anomaly: GeneratedBlockAnomaly;
  readonly path: string;
}): string {
  const { owner, block } = input.target;
  return (
    `Generated block ${owner}:${block} in ${input.path} has an anomalous ` +
    `marker (${input.anomaly.kind}) at line ${input.anomaly.line}; the ` +
    "line-anchored splice ignored it (first pair wins), but the marker " +
    "should not be there — remove it or restore the block's single " +
    "start/end pair."
  );
}
