// engine/diagnostics: small helpers for persisting engine-created diagnostics.
//
// Processor-emitted DiagnosticEffects flow through applyEffect's normal
// DiagnosticEffect route. Engine-created diagnostics (phase mismatch,
// capability rejection, scheduler/job/garden orchestration failures) need the
// same durable projection row without pretending they came from a processor
// run. This helper keeps that write path consistent and leaves the caller to
// choose the right producer id (`test.processor`, `engine.scheduler`, etc.).

import type { DiagnosticEffect } from "../core/effect";
import type { RunId } from "./runner-contract";
import type { ApplyEffectSinks } from "./apply-effect";

export async function recordDiagnosticsViaSink(opts: {
  readonly sinks: Pick<ApplyEffectSinks, "recordDiagnostic">;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly processorId: string;
  readonly proposalId: string | null;
  readonly runId?: RunId;
}): Promise<void> {
  for (const effect of opts.diagnostics) {
    await opts.sinks.recordDiagnostic({
      effect,
      processorId: opts.processorId,
      proposalId: opts.proposalId,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    });
  }
}
