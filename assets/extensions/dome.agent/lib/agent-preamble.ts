// dome.agent agent-preamble helper — the three steps every agent processor
// repeats before its own work: step-availability check → coreMemorySection
// read → config-problem diagnostics push.
//
// What the helper owns:
//   1. The step-undefined early-exit (no model provider wired → return []).
//   2. The coreMemorySection read (same call shape in every processor).
//   3. Building a DiagnosticEffect for every non-null problem entry the caller
//      passes, plus the core.problem entry (always "dome.agent.core-config-invalid").
//
// What stays at the call site (too varied to centralise):
//   - Extra guards before the preamble (empty rawPaths, parse-schedule-input).
//   - All config reads (ledger path, sweep settings, daily paths, …).
//   - sourceRefs computation (each processor has its own shape).
//   - AgentRunState init (sweep initialises per queue item, not once; brief
//     seeds the accumulator with a prepared daily immediately after).
//   - Any diagnostics beyond config problems (e.g. sweep's ledger-parse
//     warnings added after the preamble).

import { diagnosticEffect, type Effect } from "../../../../src/core/effect";
import type { ProcessorContext } from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { coreMemorySection, type CoreMemorySection } from "./core-memory";
import type { ModelStepFn } from "./agent-loop";

/**
 * A config-problem entry the caller pre-reads and passes to `agentPreamble`.
 * The helper emits a warning DiagnosticEffect for each entry whose `problem`
 * is non-null, using the caller-supplied `code` and `sourceRefs`. The core
 * problem is handled internally and does NOT need to be passed here.
 */
export type PreambleProblem = {
  readonly problem: string | null;
  readonly code: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export type AgentPreambleResult =
  | { readonly kind: "no-model" }
  | {
      readonly kind: "ready";
      /** The model-step function; use for all runAgentLoop calls this run. */
      readonly step: ModelStepFn;
      /** Core-memory resolution + rendered section. */
      readonly core: CoreMemorySection;
      /**
       * Diagnostic effects already constructed for every non-null
       * caller-passed problem PLUS the core.problem (when non-null).
       * Spread this into the processor's own effects accumulator.
       */
      readonly effects: ReadonlyArray<Effect>;
    };

/**
 * Run the shared agent-processor preamble.
 *
 * @param ctx       The processor context.
 * @param problems  Caller-supplied config problems (pre-read configs). Each
 *                  non-null `.problem` becomes a warning diagnostic with the
 *                  caller's `.code` and `.sourceRefs`. Pass `[]` when there
 *                  are no per-processor config problems (ingest, brief).
 * @param coreSourceRefs  The sourceRefs to attach to the core-config-invalid
 *                        diagnostic (when core.problem is non-null). Typically
 *                        the same refs the processor uses for all diagnostics.
 */
export async function agentPreamble(
  ctx: ProcessorContext,
  problems: ReadonlyArray<PreambleProblem>,
  coreSourceRefs: ReadonlyArray<SourceRef>,
): Promise<AgentPreambleResult> {
  const step = ctx.modelInvoke?.step;
  if (step === undefined) return Object.freeze({ kind: "no-model" }) as AgentPreambleResult;

  const core = await coreMemorySection({
    readFile: (p) => ctx.snapshot.readFile(p),
    config: ctx.extensionConfig,
  });

  const effects: Effect[] = [];
  for (const { problem, code, sourceRefs } of problems) {
    if (problem !== null) {
      effects.push(
        diagnosticEffect({ severity: "warning", code, message: problem, sourceRefs }),
      );
    }
  }
  if (core.problem !== null) {
    effects.push(
      diagnosticEffect({
        severity: "warning",
        code: "dome.agent.core-config-invalid",
        message: core.problem,
        sourceRefs: coreSourceRefs,
      }),
    );
  }

  return Object.freeze({ kind: "ready", step, core, effects: Object.freeze(effects) });
}
