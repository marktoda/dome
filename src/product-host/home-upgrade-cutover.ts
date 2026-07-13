// product-host/home-upgrade-cutover: one private, lifecycle-owned Home upgrade.
//
// The public CLI remains deliberately absent.  This Module composes the
// existing deep lifecycle, transaction, migration, candidate, and barrier
// interfaces so callers cannot reorder the irreversible handoff.

import {
  inspectHomeLifecycleSuspension,
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionDeps,
  type HomeResumeAuthorization,
  type SupervisedHomeSuspensionResult,
} from "./home-lifecycle-suspension";
import {
  commitPreparedHomeUpgrade,
  migratePreparedHomeUpgrade,
  prepareHomeUpgrade,
  readHomeUpgrade,
  readHomeUpgradeForRecovery,
  releaseCommittedHomeUpgrade,
  restoreHomeUpgrade,
  type HomeUpgradeTransaction,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";
import {
  proveHomeUpgradeCandidate,
  type HomeUpgradeCandidateDeps,
} from "./home-upgrade-candidate";
import { readVaultId } from "./vault-id";

export type HomeUpgradeCutoverOutcome =
  | { readonly kind: "committed"; readonly transaction: HomeUpgradeTransaction }
  | { readonly kind: "rolled-back"; readonly transaction: HomeUpgradeTransaction; readonly error: string }
  | { readonly kind: "recovery-required"; readonly transaction: HomeUpgradeTransaction; readonly error: string };

export type HomeUpgradeCutoverResult = {
  readonly outcome: HomeUpgradeCutoverOutcome;
  readonly lifecycle: SupervisedHomeSuspensionResult<HomeUpgradeCutoverOutcome>;
};

type UpgradeOperations = {
  readonly read: typeof readHomeUpgrade;
  readonly readRecovery: typeof readHomeUpgradeForRecovery;
  readonly prepare: typeof prepareHomeUpgrade;
  readonly migrate: typeof migratePreparedHomeUpgrade;
  readonly prove: typeof proveHomeUpgradeCandidate;
  readonly commit: typeof commitPreparedHomeUpgrade;
  readonly restore: typeof restoreHomeUpgrade;
  readonly release: typeof releaseCommittedHomeUpgrade;
  readonly readVaultId: typeof readVaultId;
};

export type HomeUpgradeCutoverDeps = HomeUpgradeTransactionDeps &
  HomeLifecycleSuspensionDeps & HomeUpgradeCandidateDeps & {
    /** One internal seam for deterministic orchestration tests. */
    readonly operations?: Partial<UpgradeOperations> | undefined;
    readonly suspendHome?: typeof withSupervisedHomeSuspended | undefined;
  };

/** Execute or recover one transaction. No caller-controlled phase exists. */
export async function runHomeUpgradeCutover(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
  readonly candidateArtifactId: string;
}, deps: HomeUpgradeCutoverDeps = {}): Promise<HomeUpgradeCutoverResult> {
  const operations = resolveOperations(deps.operations);
  const suspension = await (deps.inspectLifecycleSuspension ?? inspectHomeLifecycleSuspension)(input.vaultPath);
  if (suspension.kind === "invalid" || suspension.kind === "unavailable") {
    throw new Error(`Home lifecycle recovery evidence is ${suspension.kind}: ${suspension.error}`);
  }

  let invocation: Parameters<typeof withSupervisedHomeSuspended>[0];
  let recoveryOutcome: HomeUpgradeCutoverOutcome | null = null;
  if (suspension.kind === "inactive") {
    let existing = await operations.readRecovery(input.vaultPath, deps);
    if (existing !== null) {
      if (existing.transactionId !== input.transactionId ||
        existing.candidate.artifactId !== input.candidateArtifactId) {
        throw new Error("retained Dome Home upgrade belongs to another attempt");
      }
      if (existing.phase === "committed") {
        existing = await operations.read(input.vaultPath, deps);
        if (existing === null) throw new Error("committed upgrade candidate evidence is unavailable");
        const released = await operations.release(input.vaultPath, deps);
        return terminalWithoutLifecycle(
          Object.freeze({ kind: "committed" as const, transaction: released }),
          input.transactionId,
        );
      }
      if (existing.phase === "restored") {
        return terminalWithoutLifecycle(Object.freeze({
          kind: "rolled-back" as const,
          transaction: existing,
          error: "pre-commit upgrade was already restored",
        }), input.transactionId);
      }
      throw new Error("active pre-commit Dome Home upgrade lacks lifecycle suspension");
    }
    invocation = Object.freeze({
      mode: "new" as const,
      vaultPath: input.vaultPath,
      purpose: "upgrade" as const,
      operationId: input.transactionId,
    });
  } else {
    const active = suspension.suspension;
    if (active.purpose !== "upgrade" || active.operationId !== input.transactionId) {
      throw new Error(`Home lifecycle is owned by ${active.purpose}:${active.operationId}`);
    }
    let journal = await operations.readRecovery(input.vaultPath, deps);
    if (journal === null || journal.transactionId !== input.transactionId ||
      journal.candidate.artifactId !== input.candidateArtifactId) {
      throw new Error("lifecycle recovery does not match an exact upgrade transaction");
    }
    if (journal.phase === "prepared" || journal.phase === "switching") {
      // The retained active lifecycle row denies every start/mutation while
      // restore takes operational EXCLUSIVE and both host locks. Competing
      // recoverers serialize there, then serialize again on lifecycle Tx2;
      // recover mode is forbidden from recreating a row the winner cleared.
      journal = await operations.restore(input.vaultPath, deps);
      recoveryOutcome = Object.freeze({
        kind: "rolled-back" as const,
        transaction: journal,
        error: "recovered a pre-commit upgrade by restoring N-1",
      });
    } else if (journal.phase === "restored") {
      recoveryOutcome = Object.freeze({
        kind: "rolled-back" as const,
        transaction: journal,
        error: "pre-commit upgrade was already restored",
      });
    } else {
      // Forward recovery requires the candidate payload; rollback never does.
      journal = await operations.read(input.vaultPath, deps);
      if (journal === null) throw new Error("committed upgrade candidate evidence is unavailable");
      recoveryOutcome = Object.freeze({ kind: "committed" as const, transaction: journal });
    }
    invocation = journal.phase === "committed"
      ? Object.freeze({
        mode: "recover" as const,
        vaultPath: input.vaultPath,
        purpose: "upgrade" as const,
        operationId: input.transactionId,
        policy: "authorized-upgrade-continuation" as const,
        authorizeContinuation: async () => candidateResumeAuthorization(journal!),
      })
      : Object.freeze({
        mode: "recover" as const,
        vaultPath: input.vaultPath,
        purpose: "upgrade" as const,
        operationId: input.transactionId,
        policy: "resume-only" as const,
      });
  }

  const suspend = deps.suspendHome ?? withSupervisedHomeSuspended;
  const lifecycle = await suspend(invocation, async (context) => {
    const recoveryCurrent = await operations.readRecovery(input.vaultPath, deps);
    const current = recoveryCurrent?.phase === "committed"
      ? await operations.read(input.vaultPath, deps)
      : recoveryCurrent;
    if (current?.phase === "committed") {
      try {
        await context.authorizeCurrentHomeForResume();
        const released = await operations.release(input.vaultPath, deps);
        return Object.freeze({ kind: "committed" as const, transaction: released });
      } catch (error) {
        return Object.freeze({
          kind: "recovery-required" as const,
          transaction: current,
          error: message(error),
        });
      }
    }

    let journal: HomeUpgradeTransaction | null = current;
    try {
      journal = await operations.prepare({
        vaultPath: input.vaultPath,
        transactionId: input.transactionId,
        candidateArtifactId: input.candidateArtifactId,
      }, deps);
      journal = await operations.migrate(input.vaultPath, deps);
      const proof = await operations.prove({
        vault: journal.vault,
        vaultId: await operations.readVaultId(journal.vault),
        transactionId: journal.transactionId,
        candidate: journal.candidate,
      }, deps);
      journal = await operations.commit({ vaultPath: journal.vault, proof }, deps);
      await context.authorizeCurrentHomeForResume();
      journal = await operations.release(journal.vault, deps);
      return Object.freeze({ kind: "committed" as const, transaction: journal });
    } catch (error) {
      const latest = await operations.readRecovery(input.vaultPath, deps);
      if (latest !== null && latest.phase !== "committed" && latest.phase !== "restored") {
        try {
          const restored = await operations.restore(input.vaultPath, deps);
          return Object.freeze({ kind: "rolled-back" as const, transaction: restored, error: message(error) });
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], "pre-commit upgrade and automatic rollback both failed");
        }
      }
      if (latest?.phase === "restored") {
        return Object.freeze({ kind: "rolled-back" as const, transaction: latest, error: message(error) });
      }
      if (latest?.phase === "committed") {
        return Object.freeze({ kind: "recovery-required" as const, transaction: latest, error: message(error) });
      }
      throw error;
    }
  }, deps);

  const outcome = lifecycle.operationRan ? lifecycle.value : recoveryOutcome;
  if (outcome === null || outcome === undefined) {
    throw new Error("Home upgrade lifecycle completed without a transaction outcome");
  }
  return Object.freeze({ outcome, lifecycle });
}

function candidateResumeAuthorization(journal: HomeUpgradeTransaction): HomeResumeAuthorization {
  if (journal.phase !== "committed" || journal.selection === null) {
    throw new Error("candidate lifecycle authorization requires a committed v2 transaction");
  }
  return Object.freeze({
    operationId: journal.transactionId,
    artifactId: journal.candidate.artifactId,
    artifactVersion: journal.candidate.version,
    installationSha256: journal.selection.candidate.installation.sha256,
    plistSha256: journal.selection.candidate.plist.sha256,
  });
}

function resolveOperations(overrides: Partial<UpgradeOperations> | undefined): UpgradeOperations {
  return Object.freeze({
    read: overrides?.read ?? readHomeUpgrade,
    readRecovery: overrides?.readRecovery ?? readHomeUpgradeForRecovery,
    prepare: overrides?.prepare ?? prepareHomeUpgrade,
    migrate: overrides?.migrate ?? migratePreparedHomeUpgrade,
    prove: overrides?.prove ?? proveHomeUpgradeCandidate,
    commit: overrides?.commit ?? commitPreparedHomeUpgrade,
    restore: overrides?.restore ?? restoreHomeUpgrade,
    release: overrides?.release ?? releaseCommittedHomeUpgrade,
    readVaultId: overrides?.readVaultId ?? readVaultId,
  });
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function terminalWithoutLifecycle(
  outcome: HomeUpgradeCutoverOutcome,
  operationId: string,
): HomeUpgradeCutoverResult {
  const lifecycle = Object.freeze({
    kind: "not-required" as const,
    operationId,
    recovered: true,
    operationRan: false,
  });
  return Object.freeze({ outcome, lifecycle });
}
