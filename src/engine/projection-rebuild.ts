// engine/projection-rebuild: rebuild projection.db from the adopted commit.
//
// This is the operational form of PROJECTIONS_ARE_REBUILDABLE. It resets only
// the projection database, synthesizes an all-files signal set for the adopted
// tree, runs adoption-phase processors plus explicitly deterministic,
// projection-safe garden processors against that immutable snapshot, and routes
// projection-producing effects through the normal applyEffect broker. It
// deliberately does not apply PatchEffects, enqueue jobs, dispatch external
// work, read operational recovery state, or make model calls.

import { posix } from "node:path";

import type { Effect } from "../core/effect";
import type { Capability, Processor } from "../core/processor";
import { makeManualProposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import { readTree } from "../git";
import {
  markProjectionBuilt,
  resetProjectionDb,
} from "../projections/db";
import { queryQuestionAnswers } from "../answers/question-answers";
import { applyQuestionAnswer } from "../projections/questions";
import { buildSqliteSinks } from "../projections/sinks";
import { makeResolveTree, type VaultRuntime } from "./vault-runtime";
import { applyEffect } from "./apply-effect";
import type { SignalEvent } from "./compile-range";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import { readablePath } from "./path-capabilities";
import {
  dispatchOneProcessor,
  makeSnapshot,
} from "../processors/runtime";
import { matchTriggers } from "../processors/triggers";
import type { RunnerResult } from "./runner-contract";

export type ProjectionRebuildResult = {
  readonly adopted: CommitOid;
  readonly fileCount: number;
  readonly processorCount: number;
  readonly effectCount: number;
};

type ProjectionRebuildRun = {
  readonly phase: "adoption" | "garden";
  readonly result: RunnerResult;
};

const REBUILD_SAFE_GARDEN_CAPABILITIES: ReadonlySet<Capability["kind"]> =
  new Set(["read", "graph.write", "search.write", "question.ask"]);

export async function rebuildProjection(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly branch: string;
  readonly now?: () => Date;
}): Promise<ProjectionRebuildResult> {
  const now = opts.now ?? ((): Date => new Date());
  const files = await listFilesAtCommit(opts.runtime.path, opts.adopted);
  const signals = signalsForRebuild(files);
  const proposal = makeManualProposal({
    base: opts.adopted,
    head: opts.adopted,
    branch: opts.branch,
  });

  resetProjectionDb(opts.runtime.projectionDb);

  const sinks = buildSqliteSinks({
    projectionDb: opts.runtime.projectionDb,
    outboxDb: opts.runtime.outboxDb,
    adoptedCommit: opts.adopted,
    applyPatch: async () => null,
    captureView: async () => undefined,
    externalHandlers: opts.runtime.externalHandlers,
    recoverQuarantine: async () => undefined,
    recoverRun: async () => true,
  });

  const adoptionResults = await opts.runtime.processorRuntime.adoptionRunner({
    vault: {
      path: opts.runtime.path,
      config: { git: { auto_commit_workflows: true } },
    },
    candidate: opts.adopted,
    changedPaths: files,
    signals,
    iteration: 1,
    proposal,
  });
  const gardenResults = await runDeterministicGardenProjectionProcessors({
    runtime: opts.runtime,
    adopted: opts.adopted,
    files,
    signals,
    proposal,
  });
  const rebuildRuns: ReadonlyArray<ProjectionRebuildRun> = Object.freeze([
    ...adoptionResults.map((result) =>
      Object.freeze({ phase: "adoption" as const, result }),
    ),
    ...gardenResults.map((result) =>
      Object.freeze({ phase: "garden" as const, result }),
    ),
  ]);

  let routedEffects = 0;
  for (const run of rebuildRuns) {
    for (const effect of run.result.effects) {
      if (!isProjectionRebuildEffect(effect)) continue;
      const applied = await applyEffect({
        effect,
        processorId: run.result.processorId,
        runId: run.result.runId,
        proposalId: proposal.id,
        phase: run.phase,
        declared: run.result.declared,
        granted: run.result.granted,
        sinks,
        candidate: opts.adopted,
      });
      recordEffectCapabilityUse({
        ledger: opts.runtime.ledgerDb,
        runId: run.result.runId,
        ...(applied.capabilityUse !== undefined
          ? { capabilityUse: applied.capabilityUse }
          : {}),
      });
      routedEffects += 1;
    }
  }

  restoreDurableQuestionAnswers(opts.runtime);

  markProjectionBuilt(opts.runtime.projectionDb, {
    adoptedCommit: opts.adopted,
    extensionSet: opts.runtime.extensions,
    processorVersions: opts.runtime.processorVersions,
    capabilityPolicyHash: opts.runtime.capabilityPolicyHash,
    builtAt: now(),
  });

  return Object.freeze({
    adopted: opts.adopted,
    fileCount: files.length,
    processorCount: rebuildRuns.length,
    effectCount: routedEffects,
  });
}

async function runDeterministicGardenProjectionProcessors(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly files: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly proposal: ReturnType<typeof makeManualProposal>;
}): Promise<ReadonlyArray<RunnerResult>> {
  const processors = opts.runtime.registry
    .byPhase("garden")
    .filter(isRebuildEligibleGardenProcessor);
  if (processors.length === 0) return Object.freeze([]);

  const snapshot = await makeSnapshot(
    opts.runtime.path,
    opts.adopted,
    makeResolveTree(opts.runtime.path),
  );
  const results: RunnerResult[] = [];

  for (const processor of processors) {
    const granted = opts.runtime.resolveGrants(processor.id);
    const readableSignals = Object.freeze(
      opts.signals.filter(
        (event) =>
          readablePath(event.path, processor.capabilities, granted) !== null,
      ),
    );
    const matches = matchTriggers(processor.triggers, readableSignals);
    if (matches.length === 0) continue;

    results.push(
      await dispatchOneProcessor({
        processor,
        phase: "garden",
        envelope: Object.freeze({
          kind: "garden" as const,
          matchedTriggers: matches,
        }),
        snapshot,
        changedPaths: opts.files,
        proposal: opts.proposal,
        inputCommit: opts.adopted,
        matches,
        resolveGrants: opts.runtime.resolveGrants,
        extensionIdFor: opts.runtime.extensionIdFor,
        ledger: opts.runtime.ledgerDb,
        executionCap: opts.runtime.config.engine.executionCap,
        pageTypes: opts.runtime.pageTypes,
      }),
    );
  }

  return Object.freeze(results);
}

function isRebuildEligibleGardenProcessor(
  processor: Processor<unknown>,
): boolean {
  if (processor.execution?.class !== "deterministic") return false;
  if (
    !processor.triggers.some(
      (trigger) => trigger.kind === "signal" || trigger.kind === "path",
    )
  ) {
    return false;
  }
  return processor.capabilities.every((capability) =>
    REBUILD_SAFE_GARDEN_CAPABILITIES.has(capability.kind),
  );
}

function restoreDurableQuestionAnswers(runtime: VaultRuntime): void {
  for (const answer of queryQuestionAnswers(runtime.answersDb)) {
    applyQuestionAnswer(runtime.projectionDb, {
      idempotencyKey: answer.idempotencyKey,
      answer: answer.answer,
      answeredAt: answer.answeredAt,
    });
  }
}

async function listFilesAtCommit(
  vaultPath: string,
  commit: CommitOid,
): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  await walkTree(vaultPath, commit, "", out);
  out.sort();
  return Object.freeze(out);
}

async function walkTree(
  vaultPath: string,
  oid: string,
  prefix: string,
  out: string[],
): Promise<void> {
  const tree = await readTree({ path: vaultPath, oid });
  for (const entry of tree.tree) {
    const path = prefix === "" ? entry.path : posix.join(prefix, entry.path);
    if (entry.type === "tree") {
      await walkTree(vaultPath, entry.oid, path, out);
    } else {
      out.push(path);
    }
  }
}

function signalsForRebuild(
  paths: ReadonlyArray<string>,
): ReadonlyArray<SignalEvent> {
  const signals: SignalEvent[] = [];
  for (const path of paths) {
    signals.push(Object.freeze({ signal: "file.created", path }));
    if (path.endsWith(".md")) {
      signals.push(Object.freeze({ signal: "document.changed", path }));
    }
  }
  return Object.freeze(signals);
}

function isProjectionRebuildEffect(effect: Effect): boolean {
  return (
    effect.kind === "diagnostic" ||
    effect.kind === "fact" ||
    effect.kind === "search-document" ||
    effect.kind === "question"
  );
}
