// dome.agent.consolidate — nightly vault-janitor agent: merge duplicate pages
// + tidy within-page append-drift among RECENT drift (since the ledger's last
// recorded run). One agent loop per scheduled tick; its edits accumulate in
// one AgentRunState (overlay reads compose successive merges + link rewrites)
// and land as a single cumulative PatchEffect, hard-capped at
// MAX_CHANGED_FILES per run (nightly cadence multiplies blast radius).

import {
  diagnosticEffect,
  patchEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { makeConsolidatorTools } from "../lib/consolidate-tools";
import { consolidateCharter } from "../lib/consolidate-charter";

const MAX_STEPS = 50;
const MAX_CHANGED_FILES = 30;
const DEFAULT_LEDGER_PATH = "consolidation-ledger.md";

/**
 * Resolve the consolidation ledger path from the extension config
 * (`extensions.dome.agent.config.consolidation_ledger_path`), defaulting to
 * the top-level `consolidation-ledger.md`. The path must be a relative vault
 * `.md` path; a custom path additionally requires matching `read` +
 * `patch.auto` grant entries in `.dome/config.yaml` — grants are static
 * globs, so config cannot widen the processor's write boundary.
 */
export function consolidationLedgerPath(
  config?: Readonly<Record<string, unknown>>,
): string {
  const raw = config?.consolidation_ledger_path;
  if (raw === undefined) return DEFAULT_LEDGER_PATH;
  if (typeof raw !== "string") {
    throw new Error(
      "dome.agent config consolidation_ledger_path must be a string",
    );
  }
  if (raw.trim() !== raw || raw.length === 0 || !raw.endsWith(".md")) {
    throw new Error(
      "dome.agent config consolidation_ledger_path must be a non-empty .md path",
    );
  }
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.split("/").some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      "dome.agent config consolidation_ledger_path must be a relative vault markdown path",
    );
  }
  return raw;
}

const consolidate = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const step = ctx.modelInvoke?.step;
    if (step === undefined) return Object.freeze([]); // clean no-op without a model

    const ledgerPath = consolidationLedgerPath(ctx.extensionConfig);

    const tools = makeConsolidatorTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
    });

    const state: AgentRunState = { edits: new Map(), questions: [] };
    const sourceRefs = [ctx.sourceRef(ledgerPath)];

    let result;
    try {
      result = await runAgentLoop({
        charter: consolidateCharter({
          ledgerPath,
          maxChangedFiles: MAX_CHANGED_FILES,
        }),
        task: taskTurn(ctx.now(), ledgerPath),
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
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.consolidate-failed",
          message: `dome.agent.consolidate failed (${message}); run rolled back, no edits applied.`,
          sourceRefs,
        }),
      ]);
    }

    const effects: Effect[] = [];
    const changes = [...state.edits.values()].map((e) =>
      e.kind === "write"
        ? ({ kind: "write", path: e.path, content: e.content } as const)
        : ({ kind: "delete", path: e.path } as const),
    );
    if (changes.length > MAX_CHANGED_FILES) {
      // Per-run patch cap (nightly blast-radius bound). Partial application
      // would break merge atomicity (a delete could land without its link
      // rewrites), so an overreaching run is rolled back entirely; the
      // agent's questions still surface.
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.consolidate-overreach",
          message: `dome.agent.consolidate touched ${changes.length} files (cap ${MAX_CHANGED_FILES}); run rolled back, no edits applied.`,
          sourceRefs,
        }),
      );
    } else if (changes.length > 0) {
      effects.push(
        patchEffect({
          mode: "auto",
          changes,
          reason: "dome.agent: consolidate vault",
          sourceRefs,
        }),
      );
    }
    for (const q of state.questions) {
      effects.push(
        questionEffect({ question: q.question, idempotencyKey: q.idempotencyKey, sourceRefs }),
      );
    }
    if (result.stopReason === "budget") {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.truncated",
          message: `dome.agent.consolidate hit the ${MAX_STEPS}-step budget; partial cleanup applied, resume next run.`,
          sourceRefs,
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default consolidate;

function taskTurn(now: Date, ledgerPath: string): string {
  const today = now.toISOString().slice(0, 10);
  return [
    `Tonight is ${today}. Consolidate RECENT drift per your charter.`,
    `Start by reading ${ledgerPath}, then log.md and index.md.`,
    "Do a small bounded batch of merges + within-page tidies among recently-touched pages, then update the ledger with tonight's date.",
  ].join("\n");
}
