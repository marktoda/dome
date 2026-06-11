// dome.agent.consolidate — nightly vault-janitor agent: merge duplicate pages
// + tidy within-page append-drift among RECENT drift (since the ledger's last
// recorded run). One agent loop per scheduled tick; its edits accumulate in
// one AgentRunState (overlay reads compose successive merges + link rewrites)
// and land as a single cumulative PatchEffect, hard-capped at
// MAX_CHANGED_FILES per run (nightly cadence multiplies blast radius).

import { validateRelativeMarkdownPath } from "../../../../src/core/config-path";
import { diagnosticEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { finishAgentRun } from "../lib/agent-run-effects";
import { withCoreMemory } from "../lib/core-memory";
import { makeConsolidatorTools } from "../lib/consolidate-tools";
import { consolidateCharter } from "../lib/consolidate-charter";
import { formatDate, localDateParts } from "../../dome.daily/processors/daily-paths";
import { agentPreamble } from "../lib/agent-preamble";

const MAX_STEPS = 50;
export const MAX_CHANGED_FILES = 30;
const DEFAULT_LEDGER_PATH = "consolidation-ledger.md";

export type ConsolidationLedgerResolution = {
  readonly path: string;
  /**
   * Non-null when a malformed config value was ignored in favor of the
   * default — the caller surfaces it as a warning diagnostic. Malformed
   * config must degrade, not crash the nightly run with a raw processor
   * throw.
   */
  readonly problem: string | null;
};

/**
 * Resolve the consolidation ledger path from the extension config
 * (`extensions.dome.agent.config.consolidation_ledger_path`), defaulting to
 * the top-level `consolidation-ledger.md`. The path must be a relative vault
 * `.md` path; a malformed value falls back to the default with a `problem`
 * the processor emits as a diagnostic. A custom path additionally requires
 * matching `read` + `patch.auto` grant entries in `.dome/config.yaml` —
 * grants are static globs, so config cannot widen the processor's write
 * boundary.
 */
export function consolidationLedgerPath(
  config?: Readonly<Record<string, unknown>>,
): ConsolidationLedgerResolution {
  const raw = config?.consolidation_ledger_path;
  if (raw === undefined) return resolution(DEFAULT_LEDGER_PATH, null);
  const v = validateRelativeMarkdownPath(raw, "consolidation_ledger_path");
  if (!v.ok) return fallback(v.problem);
  return resolution(v.path, null);
}

function resolution(
  path: string,
  problem: string | null,
): ConsolidationLedgerResolution {
  return Object.freeze({ path, problem });
}

function fallback(problem: string): ConsolidationLedgerResolution {
  return resolution(
    DEFAULT_LEDGER_PATH,
    `dome.agent config ${problem}; falling back to ${DEFAULT_LEDGER_PATH}`,
  );
}

const consolidate = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const ledger = consolidationLedgerPath(ctx.extensionConfig);
    const ledgerPath = ledger.path;
    const sourceRefs = [ctx.sourceRef(ledgerPath)];

    // step check + coreMemorySection read + config-problem diagnostics
    // (ledger path problem + core-config-invalid).
    const pre = await agentPreamble(
      ctx,
      [{ problem: ledger.problem, code: "dome.agent.consolidate-config-invalid", sourceRefs }],
      sourceRefs,
    );
    if (pre.kind === "no-model") return Object.freeze([]);
    const { step, core } = pre;
    const configDiagnostics: Effect[] = [...pre.effects];

    const tools = makeConsolidatorTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
      ledgerPath,
    });

    const state: AgentRunState = { edits: new Map(), questions: [] };

    let result;
    try {
      result = await runAgentLoop({
        charter: consolidateCharter({
          ledgerPath,
          maxChangedFiles: MAX_CHANGED_FILES,
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
    `Start by reading ${ledgerPath}, then log.md and index.md.`,
    "Do a small bounded batch of merges + within-page tidies among recently-touched pages, then update the ledger with tonight's date.",
  ].join("\n");
}
