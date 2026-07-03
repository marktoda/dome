// dome.agent.consolidate — nightly vault-janitor agent: merge duplicate pages
// + tidy within-page append-drift among RECENT drift (since the ledger's last
// recorded run). One agent loop per scheduled tick; its edits accumulate in
// one AgentRunState (overlay reads compose successive merges + link rewrites)
// and land as a single cumulative PatchEffect, hard-capped at
// MAX_CHANGED_FILES per run (nightly cadence multiplies blast radius).

import { diagnosticEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import {
  resolveLedgerPath,
  resolveTargets,
  type LedgerResolution,
} from "../lib/agent-config";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { agentIntegrityEffects, finishAgentRun } from "../lib/agent-run-effects";
import { withCoreMemory } from "../lib/core-memory";
import {
  CONSOLIDATE_WRITABLE_PATHS,
  makeConsolidatorTools,
} from "../lib/consolidate-tools";
import { consolidateCharter } from "../lib/consolidate-charter";
import { formatDate, localDateParts } from "../../dome.daily/processors/daily-paths";
import { agentPreamble } from "../lib/agent-preamble";
import { resolveModelOverride, withStepModel } from "../lib/model-override";

const MAX_STEPS = 50;
export const MAX_CHANGED_FILES = 30;
const DEFAULT_LEDGER_PATH = "meta/consolidation-ledger.md";
const DEFAULT_TARGETS: ReadonlyArray<string> = Object.freeze(["wiki/"]);

/** @deprecated alias retained for callers/tests; see {@link LedgerResolution}. */
export type ConsolidationLedgerResolution = LedgerResolution;

/**
 * Resolve the consolidation ledger path from the extension config
 * (`extensions.dome.agent.config.consolidation_ledger_path`), defaulting to
 * `meta/consolidation-ledger.md`. Thin wrapper over the shared
 * {@link resolveLedgerPath}.
 */
export function consolidationLedgerPath(
  config?: Readonly<Record<string, unknown>>,
): ConsolidationLedgerResolution {
  return resolveLedgerPath(config, "consolidation_ledger_path", DEFAULT_LEDGER_PATH);
}

/**
 * Resolve `consolidate_targets` (the path prefixes the run treats as in-scope
 * for drift hunting, merging, tidying, and superseding), validated against the
 * consolidator's `CONSOLIDATE_WRITABLE_PATHS` patch.auto grant. Malformed
 * values degrade to the whole-wiki default with a `problem` the processor
 * surfaces as the `dome.agent.consolidate-config-invalid` warning.
 */
function consolidateTargets(config?: Readonly<Record<string, unknown>>) {
  return resolveTargets(
    config,
    "consolidate_targets",
    DEFAULT_TARGETS,
    CONSOLIDATE_WRITABLE_PATHS,
  );
}

const consolidate = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const ledger = consolidationLedgerPath(ctx.extensionConfig);
    const ledgerPath = ledger.path;
    const targets = consolidateTargets(ctx.extensionConfig);
    const sourceRefs = [ctx.sourceRef(ledgerPath)];

    // step check + coreMemorySection read + config-problem diagnostics
    // (ledger path + targets problems share the consolidate-config-invalid
    // code; model routing has its own; core-config-invalid is the
    // preamble's own).
    const modelOverride = resolveModelOverride(ctx.extensionConfig, "consolidate");
    const pre = await agentPreamble(
      ctx,
      [
        { problem: ledger.problem, code: "dome.agent.consolidate-config-invalid", sourceRefs },
        { problem: targets.problem, code: "dome.agent.consolidate-config-invalid", sourceRefs },
        { problem: modelOverride.problem, code: "dome.agent.model-config-invalid", sourceRefs },
      ],
      sourceRefs,
    );
    if (pre.kind === "no-model") return Object.freeze([]);
    const { core } = pre;
    // Per-processor model routing: the resolved override rides every step()
    // call via the provider-neutral `model` field.
    const step = withStepModel(pre.step, modelOverride.model);
    const configDiagnostics: Effect[] = [...pre.effects];

    const tools = makeConsolidatorTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
      ledgerPath,
    });

    const state: AgentRunState = {
      edits: new Map(),
      questions: [],
      integrityFlags: [],
    };

    let result;
    try {
      result = await runAgentLoop({
        charter: consolidateCharter({
          ledgerPath,
          maxChangedFiles: MAX_CHANGED_FILES,
          targets: targets.value,
        }),
        task: withCoreMemory(core.section, taskTurn(ctx.now(), ledgerPath)),
        tools,
        step,
        maxSteps: MAX_STEPS,
        state,
      });
    } catch (error) {
      // A mid-run throw leaves the merge half-done (e.g. a page deleted before
      // its links were rewritten), so the consolidator is atomic per run: drop
      // the partial edits and surface only a diagnostic. (Budget truncation is
      // NOT a throw — it returns normally and its partial work is intended.)
      const message = error instanceof Error ? error.message : String(error);
      return Object.freeze([
        ...configDiagnostics,
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.consolidate-failed",
          message: `dome.agent.consolidate failed (${message}); run rolled back, no edits applied.`,
          sourceRefs,
        }),
      ]);
    }

    return Object.freeze([
      ...configDiagnostics,
      // Per-run patch cap (nightly blast-radius bound): partial application
      // would break merge atomicity (a delete could land without its link
      // rewrites), so an overreaching run is rolled back entirely; the
      // agent's questions still surface.
      ...finishAgentRun({
        state,
        stopReason: result.stopReason,
        sourceRefs,
        patchReason: "dome.agent: consolidate vault",
        finalText: result.finalText,
        truncatedMessage: `dome.agent.consolidate hit the ${MAX_STEPS}-step budget; partial cleanup applied, resume next run.`,
        cap: {
          maxChangedFiles: MAX_CHANGED_FILES,
          code: "dome.agent.consolidate-overreach",
          message: (count) =>
            `dome.agent.consolidate touched ${count} files (cap ${MAX_CHANGED_FILES}); run rolled back, no edits applied.`,
        },
        noOp: {
          code: "dome.agent.consolidate-no-op",
          message: (excerpt) =>
            `dome.agent.consolidate finished without edits or questions. ` +
            `Model's final message: ${excerpt}`,
          finalText: result.finalText,
        },
      }),
      // Integrity review (folded in from the retired dome.warden.integrity):
      // each flagged finding becomes a self-clearing diagnostic anchored to the
      // flagged page — never a fact, never a patch. Model judgment stays
      // transient, resolved by resolveStaleDiagnostics on reconciliation.
      ...agentIntegrityEffects(state, (path, stableId) =>
        ctx.sourceRef(path, undefined, stableId),
      ),
    ]);
  },
});

export default consolidate;

function taskTurn(now: Date, ledgerPath: string): string {
  // Local calendar date, matching sweep/brief/create-daily — "tonight" in a
  // nightly janitor's ledger must be the owner's date, not UTC's.
  const today = formatDate(localDateParts(now));
  return [
    `Tonight is ${today}. Consolidate RECENT drift per your charter.`,
    `Start by reading ${ledgerPath}, then index.md.`,
    "Do a small bounded batch of merges + within-page tidies among recently-touched pages, then update the ledger with tonight's date.",
  ].join("\n");
}
