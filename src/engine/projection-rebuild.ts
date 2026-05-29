// engine/projection-rebuild: rebuild projection.db from the adopted commit.
//
// This is the operational form of PROJECTIONS_ARE_REBUILDABLE. It resets only
// the projection database, synthesizes an all-files signal set for the adopted
// tree, runs adoption-phase processors against that immutable snapshot, and
// routes projection-producing effects through the normal applyEffect broker.
// It deliberately does not apply PatchEffects or dispatch external work.

import { posix } from "node:path";

import type { Effect } from "../core/effect";
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
import type { VaultRuntime } from "./vault-runtime";
import { applyEffect } from "./apply-effect";
import type { SignalEvent } from "./compile-range";
import { recordEffectCapabilityUse } from "./effect-capability-use";

export type ProjectionRebuildResult = {
  readonly adopted: CommitOid;
  readonly fileCount: number;
  readonly processorCount: number;
  readonly effectCount: number;
};

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

  const runnerResults = await opts.runtime.processorRuntime.adoptionRunner({
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

  let routedEffects = 0;
  for (const result of runnerResults) {
    for (const effect of result.effects) {
      if (!isProjectionRebuildEffect(effect)) continue;
      const applied = await applyEffect({
        effect,
        processorId: result.processorId,
        runId: result.runId,
        proposalId: proposal.id,
        phase: "adoption",
        declared: result.declared,
        granted: result.granted,
        sinks,
        candidate: opts.adopted,
      });
      recordEffectCapabilityUse({
        ledger: opts.runtime.ledgerDb,
        runId: result.runId,
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
    builtAt: now(),
  });

  return Object.freeze({
    adopted: opts.adopted,
    fileCount: files.length,
    processorCount: runnerResults.length,
    effectCount: routedEffects,
  });
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
