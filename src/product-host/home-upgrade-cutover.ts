// product-host/home-upgrade-cutover: one private, lifecycle-owned Home upgrade.
//
// The public CLI remains deliberately absent.  This Module composes the
// existing deep lifecycle, transaction, migration, candidate, and barrier
// interfaces so callers cannot reorder the irreversible handoff.

import {
  HomeLifecycleContentionError,
  inspectHomeLifecycleSuspension,
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionDeps,
  type HomeSuspensionPurpose,
  type HomeResumeAuthorization,
  type SupervisedHomeSuspensionResult,
} from "./home-lifecycle-suspension";
import {
  commitPreparedHomeUpgrade,
  inspectCommittedHomeUpgradeRepair,
  migratePreparedHomeUpgrade,
  prepareHomeUpgradeCandidate,
  readCommittedHomeUpgradeForward,
  readHomeUpgradeDisposition,
  readHomeUpgradeForRecovery,
  repairCommittedHomeUpgrade,
  releaseCommittedHomeUpgrade,
  restoreHomeUpgrade,
  type HomeUpgradeRepairCandidate,
  type HomeUpgradeTransaction,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";
import {
  proveHomeUpgradeCandidate,
  type HomeUpgradeCandidateDeps,
} from "./home-upgrade-candidate";
import { readVaultId } from "./vault-id";
import {
  readHomeInstallation,
} from "./home-installation";

export type HomeUpgradeTransactionOutcome =
  | { readonly kind: "committed"; readonly transaction: HomeUpgradeTransaction }
  | { readonly kind: "rolled-back"; readonly transaction: HomeUpgradeTransaction; readonly error: string };

type HomeUpgradeHandoff = {
  readonly transactionOutcome: HomeUpgradeTransactionOutcome;
  readonly handoffError: string | null;
};

export type HomeUpgradeCutoverResult = {
  readonly status: "ready" | "recovery-required";
  readonly transactionOutcome: HomeUpgradeTransactionOutcome;
  readonly handoffError: string | null;
  readonly lifecycle: SupervisedHomeSuspensionResult<HomeUpgradeHandoff>;
};

type UpgradeOperations = {
  readonly readInstallation: typeof readHomeInstallation;
  readonly read: typeof readCommittedHomeUpgradeForward;
  readonly readDisposition: typeof readHomeUpgradeDisposition;
  readonly readRecovery: typeof readHomeUpgradeForRecovery;
  readonly inspectRepair: typeof inspectCommittedHomeUpgradeRepair;
  readonly repair: typeof repairCommittedHomeUpgrade;
  readonly prepare: typeof prepareHomeUpgradeCandidate;
  readonly migrate: typeof migratePreparedHomeUpgrade;
  readonly prove: typeof proveHomeUpgradeCandidate;
  readonly commit: typeof commitPreparedHomeUpgrade;
  readonly restore: typeof restoreHomeUpgrade;
  readonly release: typeof releaseCommittedHomeUpgrade;
  readonly readVaultId: typeof readVaultId;
};

/** Stable signal for an intent adapter to classify concurrent selection. */
export class HomeUpgradeSelectionChangedError extends Error {
  readonly expectedArtifactId: string;
  readonly selectedArtifact: {
    readonly artifactId: string;
    readonly productVersion: string;
  } | null;

  constructor(expectedArtifactId: string, selected: Awaited<ReturnType<typeof readHomeInstallation>>) {
    super("Dome Home installation selection changed before upgrade ownership");
    this.name = "HomeUpgradeSelectionChangedError";
    this.expectedArtifactId = expectedArtifactId;
    this.selectedArtifact = selected === null
      ? null
      : Object.freeze({
        artifactId: selected.artifact.id,
        productVersion: selected.artifact.version,
      });
  }
}

/** Stable signal that another lifecycle-owned intent must be allowed to finish. */
export class HomeUpgradeBusyError extends Error {
  readonly purpose: HomeSuspensionPurpose | null;
  readonly operationId: string | null;

  constructor(purpose: HomeSuspensionPurpose | null, operationId: string | null) {
    super(purpose === null || operationId === null
      ? "Home lifecycle coordinator is busy"
      : `Home lifecycle is owned by ${purpose}:${operationId}`);
    this.name = "HomeUpgradeBusyError";
    this.purpose = purpose;
    this.operationId = operationId;
  }
}

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
  /** Installation selection captured by the intent preflight. */
  readonly expectedCurrentArtifactId: string;
  /** Verified invoking artifact; only the exact committed candidate can repair forward. */
  readonly repairCandidate?: HomeUpgradeRepairCandidate | undefined;
}, deps: HomeUpgradeCutoverDeps = {}): Promise<HomeUpgradeCutoverResult> {
  const operations = resolveOperations(deps.operations);
  const suspension = await (deps.inspectLifecycleSuspension ?? inspectHomeLifecycleSuspension)(input.vaultPath);
  if (suspension.kind === "invalid" || suspension.kind === "unavailable") {
    throw new Error(`Home lifecycle recovery evidence is ${suspension.kind}: ${suspension.error}`);
  }

  let invocation: Parameters<typeof withSupervisedHomeSuspended>[0];
  let recoveryHandoff: HomeUpgradeHandoff | null = null;
  let repairRequired = false;
  if (suspension.kind === "inactive") {
    const existing = await operations.readDisposition(input.vaultPath, deps);
    if (existing !== null) {
      if (existing.transactionId !== input.transactionId ||
        existing.candidate.artifactId !== input.candidateArtifactId) {
        throw new Error("retained Dome Home upgrade belongs to another attempt");
      }
      if (existing.phase === "committed") {
        try {
          const strict = await operations.read(input.vaultPath, deps);
          if (strict === null) throw new Error("committed upgrade candidate evidence is unavailable");
          const released = await operations.release(input.vaultPath, deps);
          return terminalWithoutLifecycle(handoff(committed(released)), input.transactionId);
        } catch (error) {
          const repairError = await inspectRepairCandidate(existing, input, deps, operations);
          if (repairError !== null) {
            return recoveryRequiredWithoutLifecycle(existing, input.transactionId, repairError);
          }
          repairRequired = true;
          recoveryHandoff = handoff(committed(existing), message(error));
        }
      }
      if (existing.phase === "restored") {
        return terminalWithoutLifecycle(handoff(Object.freeze({
          kind: "rolled-back" as const,
          transaction: existing,
          error: "pre-commit upgrade was already restored",
        })), input.transactionId);
      }
      if (existing.phase !== "committed") {
        throw new Error("active pre-commit Dome Home upgrade lacks lifecycle suspension");
      }
    }
    invocation = repairRequired && existing !== null
      ? Object.freeze({
        mode: "repair" as const,
        vaultPath: input.vaultPath,
        purpose: "upgrade" as const,
        operationId: input.transactionId,
        authorizeContinuation: async () => candidateResumeAuthorization(existing),
      })
      : Object.freeze({
        mode: "new" as const,
        vaultPath: input.vaultPath,
        purpose: "upgrade" as const,
        operationId: input.transactionId,
      });
  } else {
    const active = suspension.suspension;
    if (active.purpose !== "upgrade" || active.operationId !== input.transactionId) {
      throw new HomeUpgradeBusyError(active.purpose, active.operationId);
    }
    let journal = await operations.readDisposition(input.vaultPath, deps);
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
      recoveryHandoff = handoff(Object.freeze({
        kind: "rolled-back" as const,
        transaction: journal,
        error: "recovered a pre-commit upgrade by restoring N-1",
      }));
    } else if (journal.phase === "restored") {
      recoveryHandoff = handoff(Object.freeze({
        kind: "rolled-back" as const,
        transaction: journal,
        error: "pre-commit upgrade was already restored",
      }));
    } else {
      try {
        const strict = await operations.read(input.vaultPath, deps);
        if (strict === null) throw new Error("committed upgrade candidate evidence is unavailable");
        journal = strict;
        recoveryHandoff = handoff(committed(journal));
      } catch (error) {
        const repairError = await inspectRepairCandidate(journal, input, deps, operations);
        if (repairError !== null) {
          return recoveryRequiredWithoutLifecycle(journal, input.transactionId, repairError);
        }
        repairRequired = true;
        recoveryHandoff = handoff(committed(journal), message(error));
      }
    }
    invocation = journal.phase === "committed"
      ? repairRequired
        ? Object.freeze({
          mode: "repair" as const,
          vaultPath: input.vaultPath,
          purpose: "upgrade" as const,
          operationId: input.transactionId,
          authorizeContinuation: async () => candidateResumeAuthorization(journal!),
        })
        : Object.freeze({
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
  let lifecycle: SupervisedHomeSuspensionResult<HomeUpgradeHandoff>;
  try {
    lifecycle = await suspend(invocation, async (context) => {
      const recoveryCurrent = await operations.readDisposition(input.vaultPath, deps);
      let current = recoveryCurrent;
      if (recoveryCurrent?.phase === "committed") {
        try {
          current = await operations.read(input.vaultPath, deps);
          if (current === null) throw new Error("committed upgrade candidate evidence is unavailable");
        } catch (error) {
          if (input.repairCandidate === undefined) {
            return handoff(committed(recoveryCurrent), message(error));
          }
          try {
            current = await operations.repair({
              vaultPath: input.vaultPath,
              transactionId: recoveryCurrent.transactionId,
              candidate: input.repairCandidate,
            }, deps);
          } catch (repairError) {
            void repairError;
            return handoff(committed(recoveryCurrent), "committed candidate forward repair failed");
          }
        }
      }
      if (current?.phase === "committed") {
        try {
          await context.authorizeCurrentHomeForResume();
          const released = await operations.release(input.vaultPath, deps);
          return handoff(committed(released));
        } catch (error) {
          return handoff(committed(current), message(error));
        }
      }

      let journal: HomeUpgradeTransaction | null = current;
      try {
        if (journal === null) {
          const selected = await operations.readInstallation(input.vaultPath, deps);
          if (selected?.artifact.id !== input.expectedCurrentArtifactId) {
            throw new HomeUpgradeSelectionChangedError(input.expectedCurrentArtifactId, selected);
          }
          if (input.repairCandidate === undefined ||
            input.repairCandidate.manifest.artifact.id !== input.candidateArtifactId) {
            throw new Error("exact invoking candidate is required before upgrade preparation");
          }
        }
        if (journal === null) {
          journal = await operations.prepare({
            vaultPath: input.vaultPath,
            transactionId: input.transactionId,
            candidate: input.repairCandidate!,
          }, deps);
        }
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
        return handoff(committed(journal));
      } catch (error) {
        const latest = await operations.readDisposition(input.vaultPath, deps);
        if (latest !== null && latest.phase !== "committed" && latest.phase !== "restored") {
          try {
            const restored = await operations.restore(input.vaultPath, deps);
            return handoff(Object.freeze({ kind: "rolled-back" as const, transaction: restored, error: message(error) }));
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], "pre-commit upgrade and automatic rollback both failed");
          }
        }
        if (latest?.phase === "restored") {
          return handoff(Object.freeze({ kind: "rolled-back" as const, transaction: latest, error: message(error) }));
        }
        if (latest?.phase === "committed") {
          return handoff(committed(latest), message(error));
        }
        throw error;
      }
    }, deps);
  } catch (error) {
    if (error instanceof HomeLifecycleContentionError) {
      throw new HomeUpgradeBusyError(
        error.owner?.purpose ?? null,
        error.owner?.operationId ?? null,
      );
    }
    if (recoveryHandoff?.transactionOutcome.kind === "committed") {
      return recoveryRequiredWithoutLifecycle(
        recoveryHandoff.transactionOutcome.transaction,
        input.transactionId,
        message(error),
      );
    }
    throw error;
  }

  const completed = lifecycle.operationRan ? lifecycle.value : recoveryHandoff;
  if (completed === null || completed === undefined) {
    throw new Error("Home upgrade lifecycle completed without a transaction outcome");
  }
  return result(completed, lifecycle);
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
    readInstallation: overrides?.readInstallation ?? readHomeInstallation,
    read: overrides?.read ?? readCommittedHomeUpgradeForward,
    readDisposition: overrides?.readDisposition ?? readHomeUpgradeDisposition,
    readRecovery: overrides?.readRecovery ?? readHomeUpgradeForRecovery,
    inspectRepair: overrides?.inspectRepair ?? inspectCommittedHomeUpgradeRepair,
    repair: overrides?.repair ?? repairCommittedHomeUpgrade,
    prepare: overrides?.prepare ?? prepareHomeUpgradeCandidate,
    migrate: overrides?.migrate ?? migratePreparedHomeUpgrade,
    prove: overrides?.prove ?? proveHomeUpgradeCandidate,
    commit: overrides?.commit ?? commitPreparedHomeUpgrade,
    restore: overrides?.restore ?? restoreHomeUpgrade,
    release: overrides?.release ?? releaseCommittedHomeUpgrade,
    readVaultId: overrides?.readVaultId ?? readVaultId,
  });
}

async function inspectRepairCandidate(
  journal: HomeUpgradeTransaction,
  input: Parameters<typeof runHomeUpgradeCutover>[0],
  deps: HomeUpgradeCutoverDeps,
  operations: UpgradeOperations,
): Promise<string | null> {
  const candidate = input.repairCandidate;
  if (candidate === undefined || candidate.manifest.artifact.id !== journal.candidate.artifactId ||
    candidate.manifest.product.version !== journal.candidate.version) {
    return "exact invoking committed candidate is required for forward repair";
  }
  try {
    await operations.inspectRepair({
      vaultPath: input.vaultPath,
      transactionId: journal.transactionId,
      candidate,
    }, deps);
    return null;
  } catch {
    return "exact invoking committed candidate is required for forward repair";
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function terminalWithoutLifecycle(
  completed: HomeUpgradeHandoff,
  operationId: string,
): HomeUpgradeCutoverResult {
  const lifecycle = Object.freeze({
    kind: "not-required" as const,
    operationId,
    recovered: true,
    operationRan: false,
  });
  return result(completed, lifecycle);
}

function recoveryRequiredWithoutLifecycle(
  transaction: HomeUpgradeTransaction,
  operationId: string,
  error: string,
): HomeUpgradeCutoverResult {
  const lifecycle = Object.freeze({
    kind: "failed" as const,
    operationId,
    recovered: true,
    operationRan: false,
    error,
  });
  return result(handoff(committed(transaction), error), lifecycle);
}

function committed(transaction: HomeUpgradeTransaction): HomeUpgradeTransactionOutcome {
  return Object.freeze({ kind: "committed" as const, transaction });
}

function handoff(
  transactionOutcome: HomeUpgradeTransactionOutcome,
  handoffError: string | null = null,
): HomeUpgradeHandoff {
  return Object.freeze({ transactionOutcome, handoffError });
}

function result(
  completed: HomeUpgradeHandoff,
  lifecycle: SupervisedHomeSuspensionResult<HomeUpgradeHandoff>,
): HomeUpgradeCutoverResult {
  const status = completed.handoffError === null &&
      (lifecycle.kind === "ready" || lifecycle.kind === "not-required")
    ? "ready" as const
    : "recovery-required" as const;
  return Object.freeze({
    status,
    transactionOutcome: completed.transactionOutcome,
    handoffError: completed.handoffError,
    lifecycle,
  });
}
