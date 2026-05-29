// engine/commands: the view-phase command dispatcher.
//
// Per [[wiki/specs/processors]] §"View phase" and Phase 4b in
// [[cohesive/brainstorms/2026-05-27-v1-engine-completion]], view-phase
// processors fire on command invocation: a CLI command (`dome lint`),
// an MCP tool call (`dome.run_command`), or a future HTTP request all
// land here. This module is the engine-side dispatcher that wraps the
// runtime's `viewRunner` with effect routing.
//
// Phase 4b scope:
//   - One command name → at most one view-phase processor fires (the
//     processor registry rejects collisions while opening the runtime per
//     `RegistryError.kind === "duplicate-command-trigger"`).
//   - Returns the collected `ViewEffect`s — ready for the caller to
//     render (CLI prints `markdown` content; MCP wraps as a typed
//     response; etc.).
//   - Non-ViewEffect emissions from a view-phase processor are
//     phase-rejected via `applyEffect`'s phase compatibility check
//     and surfaced as broker diagnostics.
//
// Schedule-triggered view processors (e.g., `dome.lint`'s weekly
// `cron '0 7 * * MON'` report) wire through Phase 4c's scheduler;
// this module handles only the command-driven path.
//
// House-style notes:
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` for output isolation.
//   - Pure dispatcher — owns no I/O directly; injects through `sinks`.

import type {
  DiagnosticEffect,
  ViewEffect,
} from "../core/effect";
import type { CommitOid } from "../core/source-ref";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import type { LedgerDb } from "../ledger/db";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import type { RunId, ViewPhaseRunner } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

// ----- RunCommandResult -----------------------------------------------------

/**
 * The outcome of one `runViewCommand` invocation.
 *
 *   - `kind: "found"`        — a view-phase processor matched the command;
 *                             `effects` holds the collected ViewEffects
 *                             (typically one; some processors may emit
 *                             multiple chunks of a streaming view).
 *   - `kind: "not-found"`    — no view-phase processor declared a
 *                             `command: <name>` trigger matching the
 *                             supplied name.
 *
 * Non-View effects emitted by the processor (PatchEffect / DiagnosticEffect /
 * etc.) are NOT in `effects` — they're rejected by phase-compatibility at
 * the `applyEffect` boundary. The phase-mismatch diagnostics for those
 * rejections accumulate in `brokerDiagnostics` for the caller to surface.
 */
export type RunCommandResult =
  | {
      readonly kind: "found";
      readonly runId: RunId;
      readonly processorId: string;
      readonly effects: ReadonlyArray<ViewEffect>;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | {
      readonly kind: "not-found";
      readonly commandName: string;
    };

// ----- runViewCommand -------------------------------------------------------

/**
 * Dispatch a view-phase command. Looks up the matching processor (via
 * the injected `viewRunner`), runs it against the adopted snapshot, and
 * routes its emitted effects through `applyEffect({ phase: "view", ... })`.
 *
 * View phase rejects mutation effects: PatchEffect / DiagnosticEffect
 * (severity: "block") / FactEffect / QuestionEffect / JobEffect /
 * ExternalActionEffect all surface as `phase-mismatch` diagnostics. The
 * diagnostics accumulate in `brokerDiagnostics` so the caller can render
 * "processor misbehaved" detail (the run still completes; the misbehaving
 * processor is a substrate-discovery moment, not a hard failure).
 *
 * Returns `kind: "not-found"` when no view-phase processor declares a
 * matching `command:` trigger. The caller (CLI / MCP / etc.) typically
 * surfaces this as an "unknown command" error.
 */
export async function runViewCommand(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly commandName: string;
  readonly commandArgs?: unknown;
  readonly viewRunner: ViewPhaseRunner;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
}): Promise<RunCommandResult> {
  const {
    vault,
    adopted,
    commandName,
    commandArgs,
    viewRunner,
    sinks,
    ledger,
  } = opts;

  const result = await viewRunner({
    vault,
    adopted,
    commandName,
    commandArgs: commandArgs ?? null,
  });

  if (result === null) {
    return Object.freeze({
      kind: "not-found" as const,
      commandName,
    });
  }

  // Route every emitted effect through applyEffect with phase: "view".
  // The phase-compatibility check at `apply-effect.ts:isPhaseCompatible`
  // rejects every non-ViewEffect emission as `phase-mismatch`. We
  // collect the (allowed) ViewEffects + the broker diagnostics
  // separately so the caller can distinguish "the view that was
  // rendered" from "broker noise about misbehavior."
  const viewEffects: ViewEffect[] = [];
  const brokerDiagnostics: DiagnosticEffect[] = [];

  for (const effect of result.effects) {
    const applied = await applyEffect({
      effect,
      processorId: result.processorId,
      runId: result.runId,
      // View-phase runs have no proposalId — they aren't proposal-
      // anchored. The applyEffect's diagnostic sink accepts null.
      proposalId: null,
      phase: "view",
      declared: result.declared,
      granted: result.granted,
      sinks,
      candidate: adopted,
    });

    if (applied.diagnostics.length > 0) {
      brokerDiagnostics.push(...applied.diagnostics);
    }

    recordEffectCapabilityUse({
      ledger,
      runId: result.runId,
      ...(applied.capabilityUse !== undefined
        ? { capabilityUse: applied.capabilityUse }
        : {}),
    });

    // Collect the ViewEffect for return. We pull from
    // `applied.appliedEffect` (the post-broker effect) rather than
    // the input — the broker may have downgraded the effect (though
    // ViewEffect downgrade is rare in practice).
    if (
      applied.appliedEffect !== null &&
      applied.appliedEffect.kind === "view"
    ) {
      viewEffects.push(applied.appliedEffect);
    }
  }

  return Object.freeze({
    kind: "found" as const,
    runId: result.runId,
    processorId: result.processorId,
    effects: Object.freeze([...viewEffects]),
    brokerDiagnostics: Object.freeze([...brokerDiagnostics]),
  });
}
