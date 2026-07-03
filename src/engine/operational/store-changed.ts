// engine/operational/store-changed: dispatch garden processors subscribed to a
// store-change signal after a tick (or resolve) changed the backing engine
// store. Generalizes the `questions.changed` pattern
// (src/engine/operational/questions-changed.ts) to the two additional
// store-change signals shipped by the pruning pass:
//
//   - `outbox.changed`     — fired from the outbox dispatcher's two internal
//     terminal-failure sites (recordFailedAttempt terminal branch +
//     recoverExpiredDispatching terminal branch).
//   - `quarantine.changed` — fired narrowly from the processor-execution-state
//     store at the quarantine threshold-trip and at every clear.
//
// Like `questions.changed`, these signals are NOT synthesized by
// `compileRange` — they are store-change-derived, not tree-diff-derived
// (processors.md §"Triggers and signals"). Their emit points set a tick-scoped
// flag at the host; the host epilogue calls this module ONCE per tick per
// signal after operational work completes (snapshot+clear before dispatch — a
// flag re-set by the dispatch's own work waits for the next tick, the recursion
// guard). The resolve path dispatches directly after answer handlers complete.
//
// Subscribers are ordinary garden processors declaring
// `{ kind: "signal", name: <store signal> }`. This module synthesizes their
// TriggerMatches directly rather than routing through compileRange's
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

/** The store-change signals dispatched through this operational channel. */
export type StoreChangeSignal = "outbox.changed" | "quarantine.changed";

export type StoreChangedOptions = GardenRunDeps & {
  // `storeSignal` (not `signal`): `GardenRunDeps.signal` is the AbortSignal.
  readonly storeSignal: StoreChangeSignal;
  readonly registry: ProcessorRegistry;
};

export type StoreChangedResult = {
  readonly dispatched: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

/**
 * Dispatch every garden processor subscribed to
 * `{ kind: "signal", name: opts.storeSignal }`. Synthesizes TriggerMatches directly
 * (no compileRange, no path filter). Mirrors runQuestionsChangedSubscribers:
 * `opts` ⊇ GardenRunDeps is forwarded to dispatchGardenRun untouched, and a
 * dispatch crash degrades to an error diagnostic rather than aborting the
 * caller's tick.
 */
export async function runStoreChangedSubscribers(
  opts: StoreChangedOptions,
): Promise<StoreChangedResult> {
  try {
    return await runStoreChangedSubscribersInner(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const crashDiag = diagnosticEffect({
      severity: "error",
      code: "store-changed.dispatch-crashed",
      message: `${opts.storeSignal} dispatch crashed: ${msg}`,
      sourceRefs: [],
    });
    const diagnostics: DiagnosticEffect[] = [crashDiag];
    try {
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: [crashDiag],
        processorId: "engine.store-changed",
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
          code: "store-changed.dispatch-diagnostic-record-failed",
          message: `${opts.storeSignal} dispatch diagnostic was not recorded: ${recordMsg}`,
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

async function runStoreChangedSubscribersInner(
  opts: StoreChangedOptions,
): Promise<StoreChangedResult> {
  const event = Object.freeze({ signal: opts.storeSignal, path: "" });
  const candidates = storeChangedCandidates(opts.registry, opts.storeSignal, event);
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
          code: "store-changed.garden-sub-proposal-spawn-disabled",
          message:
            `${opts.storeSignal} subscriber ${candidate.processor.id} emitted ` +
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

function storeChangedCandidates(
  registry: ProcessorRegistry,
  signal: StoreChangeSignal,
  event: { readonly signal: StoreChangeSignal; readonly path: string },
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
        trigger.kind === "signal" && trigger.name === signal,
    );
    if (triggers.length === 0) continue;
    out.push(
      Object.freeze({
        processor,
        matches: Object.freeze(
          triggers.map((trigger) =>
            Object.freeze({
              trigger,
              matchedSignals: Object.freeze([event]),
            }),
          ),
        ),
      }),
    );
  }
  return Object.freeze(out);
}
