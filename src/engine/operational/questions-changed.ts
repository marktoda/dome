// engine/operational/questions-changed: dispatch garden processors subscribed
// to the `questions.changed` signal after a tick (or a resolve) changed the
// open-question set.
//
// `questions.changed` is the one Signal NOT synthesized by `compileRange` — it
// is store-change-derived, not tree-diff-derived (processors.md §"Triggers and
// signals"). The emit points (question.ask inserts/refreshes, stale-question
// resolution, durable answers) set a tick-scoped flag at the host; the host
// epilogue calls this module ONCE per tick after operational work completes
// (snapshot+clear before dispatch — a flag re-set by the dispatch's own work
// waits for the next tick, which is the recursion guard). The resolve path
// dispatches directly after answer handlers complete.
//
// Subscribers are ordinary garden processors declaring
// `{ kind: "signal", name: "questions.changed" }`. This module synthesizes
// their TriggerMatches directly rather than routing through compileRange's
// per-Proposal computation, so there is no path filtering — the SignalEvent's
// `path` is `""`. The envelope is byte-compatible with what runtime.ts hands
// real garden signal fires: `{ kind: "garden", matchedTriggers }`.

import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../../core/effect";
import type { Processor, SignalTrigger } from "../../core/processor";
import type { ProcessorRegistry } from "../../processors/registry";
import type { TriggerMatch } from "../../processors/triggers";
import { recordDiagnosticsViaSink } from "../core/diagnostics";
import {
  dispatchGardenRun,
  type GardenRunDeps,
} from "../garden/garden-run";

export type QuestionsChangedOptions = GardenRunDeps & {
  readonly registry: ProcessorRegistry;
};

export type QuestionsChangedResult = {
  readonly dispatched: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

// The synthesized SignalEvent every match carries. `path: ""` — this signal
// is not about any vault path, and subscribers get no path filtering.
const QUESTIONS_CHANGED_EVENT = Object.freeze({
  signal: "questions.changed" as const,
  path: "",
});

/**
 * Dispatch every garden processor subscribed to
 * `{ kind: "signal", name: "questions.changed" }`. Synthesizes TriggerMatches
 * directly (no compileRange, no path filter). Mirrors runAnswerHandlers:
 * `opts` ⊇ GardenRunDeps is forwarded to dispatchGardenRun untouched, and a
 * dispatch crash degrades to an error diagnostic rather than aborting the
 * caller's tick.
 */
export async function runQuestionsChangedSubscribers(
  opts: QuestionsChangedOptions,
): Promise<QuestionsChangedResult> {
  try {
    return await runQuestionsChangedSubscribersInner(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const crashDiag = diagnosticEffect({
      severity: "error",
      code: "questions-changed.dispatch-crashed",
      message: `questions.changed dispatch crashed: ${msg}`,
      sourceRefs: [],
    });
    const diagnostics: DiagnosticEffect[] = [crashDiag];
    try {
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: [crashDiag],
        processorId: "engine.questions-changed",
        proposalId: null,
      });
    } catch (recordError) {
      const recordMsg =
        recordError instanceof Error
          ? recordError.message
          : String(recordError);
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "questions-changed.dispatch-diagnostic-record-failed",
          message: `questions.changed dispatch diagnostic was not recorded: ${recordMsg}`,
          sourceRefs: [],
        }),
      );
    }
    return Object.freeze({
      dispatched: 0,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

async function runQuestionsChangedSubscribersInner(
  opts: QuestionsChangedOptions,
): Promise<QuestionsChangedResult> {
  const candidates = questionsChangedCandidates(opts.registry);
  if (candidates.length === 0) {
    return Object.freeze({ dispatched: 0, diagnostics: Object.freeze([]) });
  }

  const diagnostics: DiagnosticEffect[] = [];
  let dispatched = 0;

  for (const candidate of candidates) {
    await dispatchGardenRun(
      opts,
      {
        processor: candidate.processor,
        phase: "garden",
        envelope: Object.freeze({
          kind: "garden" as const,
          matchedTriggers: candidate.matches,
        }),
        matches: candidate.matches,
        disabledDiagnostic: {
          code: "questions-changed.garden-sub-proposal-spawn-disabled",
          message:
            `questions.changed subscriber ${candidate.processor.id} emitted ` +
            `an authorized PatchEffect, but no adoptSubProposal callback was ` +
            `wired; patch dropped.`,
        },
      },
      diagnostics,
    );
    dispatched += 1;
  }

  return Object.freeze({
    dispatched,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function questionsChangedCandidates(
  registry: ProcessorRegistry,
): ReadonlyArray<{
  readonly processor: Processor<unknown>;
  readonly matches: ReadonlyArray<TriggerMatch>;
}> {
  const out: {
    readonly processor: Processor<unknown>;
    readonly matches: ReadonlyArray<TriggerMatch>;
  }[] = [];
  for (const processor of registry.byPhase("garden")) {
    const triggers = processor.triggers.filter(
      (trigger): trigger is SignalTrigger =>
        trigger.kind === "signal" && trigger.name === "questions.changed",
    );
    if (triggers.length === 0) continue;
    out.push(
      Object.freeze({
        processor,
        matches: Object.freeze(
          triggers.map((trigger) =>
            Object.freeze({
              trigger,
              matchedSignals: Object.freeze([QUESTIONS_CHANGED_EVENT]),
            }),
          ),
        ),
      }),
    );
  }
  return Object.freeze(out);
}
