// product-host/home-upgrade: one intent-level Home upgrade operation.
// This adapter resolves artifact/attempt identity and delegates irreversible
// work to the private cutover. It does not expose phases or recovery controls.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ensureManagedRelease,
  homeInstallationPaths,
  readHomeInstallation,
  type HomeInstallationRecord,
} from "./home-installation";
import { verifyHomeArtifact, type HomeArtifactManifest } from "./home-artifact";
import { manageHome } from "./home-lifecycle";
import {
  inspectHomeLifecycleSuspension,
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionInspection,
  type SupervisedHomeSuspensionResult,
} from "./home-lifecycle-suspension";
import {
  HomeUpgradeBusyError,
  HomeUpgradeSelectionChangedError,
  runHomeUpgradeCutover,
  type HomeUpgradeCutoverDeps,
  type HomeUpgradeCutoverResult,
} from "./home-upgrade-cutover";
import {
  readHomeUpgradeCandidateReceipt,
  retireHomeUpgrade,
  type HomeUpgradeHistorySummary,
  type HomeUpgradeHistoryDeps,
} from "./home-upgrade-history";
import {
  inspectCommittedHomeUpgradeRepair,
  readCommittedHomeUpgradeForward,
  readHomeUpgradeDisposition,
  type HomeUpgradeTransaction,
} from "./home-upgrade-transaction";
import { isHomeUpgradeVersionAdvance } from "./home-upgrade-version";

export const HOME_UPGRADE_RESULT_SCHEMA = "dome.home.upgrade/v1" as const;

export type HomeUpgradeArtifactSummary = {
  readonly artifactId: string;
  readonly productVersion: string;
};

export type HomeUpgradeResult = {
  readonly schema: typeof HOME_UPGRADE_RESULT_SCHEMA;
  readonly operation: "upgrade";
  readonly status:
    | "upgraded"
    | "already-current"
    | "rolled-back"
    | "recovered-rerun-required"
    | "recovery-required"
    | "error";
  readonly exitCode: 0 | 1 | 64 | 75;
  readonly vault: string;
  readonly requestedArtifact: HomeUpgradeArtifactSummary | null;
  readonly transaction: {
    readonly operationId: string;
    readonly candidate: HomeUpgradeArtifactSummary;
    readonly outcome: "committed" | "restored";
  } | null;
  readonly selectedArtifact: HomeUpgradeArtifactSummary | null;
  readonly recovered: boolean;
  readonly service: "ready" | "stopped" | "deferred" | "failed" | "unknown";
  readonly reason:
    | "preflight-failed"
    | "candidate-failed"
    | "prior-attempt-recovered"
    | "candidate-repair-required"
    | "selection-changed"
    | "busy"
    | "coordination-failed"
    | null;
  readonly message: string;
  readonly nextAction:
    | "none"
    | "rerun-requested-upgrade"
    | "retry-recovery"
    | "supply-exact-candidate"
    | "inspect-home-status";
};

type IntentOperations = {
  readonly canonicalizeVault: (path: string) => Promise<string>;
  readonly verifyInvokingArtifact: (root: string) => Promise<HomeArtifactManifest>;
  readonly publishCandidate: typeof ensureManagedRelease;
  readonly readInstallation: typeof readHomeInstallation;
  readonly inspectLifecycle: typeof inspectHomeLifecycleSuspension;
  readonly readActive: typeof readHomeUpgradeDisposition;
  readonly readCandidateReceipt: typeof readHomeUpgradeCandidateReceipt;
  readonly readForward: typeof readCommittedHomeUpgradeForward;
  readonly inspectRepair: typeof inspectCommittedHomeUpgradeRepair;
  readonly cutover: typeof runHomeUpgradeCutover;
  readonly retire: typeof retireHomeUpgrade;
  readonly recoverOrphan: (
    vaultPath: string,
    operationId: string,
    deps: HomeUpgradeIntentDeps,
  ) => Promise<SupervisedHomeSuspensionResult<void>>;
  readonly inspectService: (
    vaultPath: string,
    deps: HomeUpgradeIntentDeps,
  ) => Promise<HomeUpgradeResult["service"]>;
  readonly operationId: () => string;
};

export type HomeUpgradeIntentDeps = HomeUpgradeCutoverDeps & HomeUpgradeHistoryDeps & {
  readonly artifactRoot?: string | undefined;
  /** One internal seam for intent/recovery decision-table tests. */
  readonly intentOperations?: Partial<IntentOperations> | undefined;
};

export async function manageHomeUpgrade(input: {
  readonly action: "run";
  readonly vaultPath: string;
}, deps: HomeUpgradeIntentDeps = {}): Promise<HomeUpgradeResult> {
  const operations = resolveOperations(deps.intentOperations);
  let vault = resolve(input.vaultPath);
  let requested: HomeUpgradeArtifactSummary | null = null;
  try { vault = await operations.canonicalizeVault(vault); }
  catch {
    return failure(vault, null, "error", 64, "preflight-failed", "Dome Home vault preflight failed", "inspect-home-status");
  }
  if ((deps.platform ?? process.platform) !== "darwin") {
    return failure(vault, null, "error", 64, "preflight-failed", "Dome Home upgrade requires macOS", "inspect-home-status");
  }
  const artifactRoot = resolve(deps.artifactRoot ?? resolve(import.meta.dir, "../../.."));
  let manifest: HomeArtifactManifest;
  try { manifest = await operations.verifyInvokingArtifact(artifactRoot); }
  catch (error) {
    try {
      const committed = await operations.readActive(vault, deps);
      if (committed?.phase === "committed") {
        return failure(
          vault,
          null,
          "recovery-required",
          1,
          "candidate-repair-required",
          "exact invoking committed candidate is required for forward repair",
          "supply-exact-candidate",
          {
            transaction: committed,
            selected: artifactSummary(committed.candidate.artifactId, committed.candidate.version),
          },
        );
      }
    } catch { /* Preserve the invoking-artifact error when disposition is unavailable. */ }
    return failure(vault, null, "error", 64, "preflight-failed", "invoking Dome Home artifact is invalid", "inspect-home-status");
  }
  requested = artifactSummary(manifest.artifact.id, manifest.product.version);
  try {
    const suspension = await operations.inspectLifecycle(vault);
    if (suspension.kind === "unavailable") {
      return failure(vault, requested, "error", 75, "busy", "Home lifecycle coordinator is temporarily unavailable", "rerun-requested-upgrade");
    }
    if (suspension.kind === "invalid") {
      return failure(vault, requested, "recovery-required", 1, "coordination-failed", "Home lifecycle recovery evidence is invalid", "inspect-home-status");
    }
    const active = await operations.readActive(vault, deps);
    let selected: HomeInstallationRecord | null;
    if (active?.phase === "committed") {
      try { selected = await operations.readInstallation(vault, deps); }
      catch { selected = null; }
    } else {
      selected = await operations.readInstallation(vault, deps);
      if (selected === null) {
        return failure(vault, requested, "error", 64, "preflight-failed", "Dome Home has no managed installation", "inspect-home-status");
      }
    }
    const retained = await resolveRetained({
      vault,
      requested,
      repairCandidate: Object.freeze({ source: artifactRoot, manifest }),
      selected,
      suspension,
      active,
      deps,
      operations,
    });
    if (retained.kind === "result") return retained.value;

    const current = await operations.readInstallation(vault, deps);
    if (current === null) {
      return failure(vault, requested, "error", 64, "preflight-failed", "Dome Home installation disappeared", "inspect-home-status");
    }
    if (sameArtifact(installationSummary(current), requested)) {
      const service = await operations.inspectService(vault, deps);
      if (service !== "ready" && service !== "stopped") {
        return failure(vault, requested, "error", 1, "coordination-failed", "selected Dome Home artifact is not ready or stopped", "inspect-home-status", {
          selected: installationSummary(current),
          service,
        });
      }
      return output({
        vault,
        requested,
        selected: installationSummary(current),
        status: "already-current",
        exitCode: 0,
        service,
        message: "The invoking Dome Home artifact is already selected.",
      });
    }

    const priorRestore = await operations.readCandidateReceipt(vault, requested.artifactId, deps);
    if (priorRestore !== null) {
      return output({
        vault,
        requested,
        selected: installationSummary(current),
        transaction: priorRestore,
        status: "rolled-back",
        exitCode: 1,
        recovered: true,
        service: await operations.inspectService(vault, deps),
        reason: "candidate-failed",
        nextAction: "none",
        message: "This exact Dome Home artifact was previously rolled back.",
      });
    }

    if (manifest.distribution.upgradeSupported !== true ||
      manifest.writerBarrier?.protocol !== 1 || manifest.durableState === undefined) {
      return failure(vault, requested, "error", 64, "preflight-failed", "invoking artifact is not upgrade-capable", "inspect-home-status", {
        selected: installationSummary(current),
      });
    }
    if (!isHomeUpgradeVersionAdvance(current.artifact.version, requested.productVersion)) {
      return failure(vault, requested, "error", 64, "preflight-failed", "invoking artifact does not advance the installed SemVer version", "inspect-home-status", {
        selected: installationSummary(current),
      });
    }

    await operations.publishCandidate({
      source: artifactRoot,
      manifest,
      paths: homeInstallationPaths(vault, deps),
      platform: deps.platform ?? process.platform,
    }, deps);
    const transactionId = operations.operationId();
    try {
      const cutover = await operations.cutover({
        vaultPath: vault,
        transactionId,
        candidateArtifactId: requested.artifactId,
        expectedCurrentArtifactId: current.artifact.id,
        repairCandidate: Object.freeze({ source: artifactRoot, manifest }),
      }, deps);
      return await finalizeCutover(vault, requested, cutover, false, deps, operations);
    } catch (error) {
      if (error instanceof HomeUpgradeSelectionChangedError) {
        if (error.selectedArtifact !== null && sameArtifact(error.selectedArtifact, requested)) {
          const service = await operations.inspectService(vault, deps);
          if (service === "ready" || service === "stopped") {
            return output({
              vault,
              requested,
              selected: error.selectedArtifact,
              status: "already-current",
              exitCode: 0,
              service,
              message: "A concurrent upgrade selected this exact Dome Home artifact.",
            });
          }
        }
        return failure(vault, requested, "error", 75, "selection-changed", "Dome Home selection changed during upgrade", "rerun-requested-upgrade", {
          selected: error.selectedArtifact,
        });
      }
      if (error instanceof HomeUpgradeBusyError) {
        return failure(vault, requested, "error", 75, "busy", "another Dome Home lifecycle operation is active", "rerun-requested-upgrade", {
          selected: installationSummary(current),
        });
      }
      throw error;
    }
  } catch {
    return failure(vault, requested, "error", 1, "coordination-failed", "Dome Home upgrade coordination failed", "inspect-home-status");
  }
}

async function resolveRetained(input: {
  readonly vault: string;
  readonly requested: HomeUpgradeArtifactSummary;
  readonly repairCandidate: { readonly source: string; readonly manifest: HomeArtifactManifest };
  readonly selected: HomeInstallationRecord | null;
  readonly suspension: Extract<HomeLifecycleSuspensionInspection, { kind: "inactive" | "active" }>;
  readonly active: HomeUpgradeTransaction | null;
  readonly deps: HomeUpgradeIntentDeps;
  readonly operations: IntentOperations;
}): Promise<{ readonly kind: "continue" } | { readonly kind: "result"; readonly value: HomeUpgradeResult }> {
  const { vault, requested, repairCandidate, selected, suspension, active, deps, operations } = input;
  const selectedArtifact = selected === null
    ? active === null
      ? null
      : active.phase === "committed"
        ? artifactSummary(active.candidate.artifactId, active.candidate.version)
        : artifactSummary(active.old.artifactId, active.old.version)
    : installationSummary(selected);
  if (suspension.kind === "active" && active === null) {
    if (suspension.suspension.purpose !== "upgrade") {
      return resultValue(failure(vault, requested, "error", 75, "busy", `Home lifecycle is owned by ${suspension.suspension.purpose}`, "inspect-home-status", {
        selected: selectedArtifact,
      }));
    }
    const recovered = await operations.recoverOrphan(vault, suspension.suspension.operationId, deps);
    const service = serviceFromLifecycle(recovered);
    if (service !== "ready" && service !== "stopped") {
      return resultValue(failure(vault, requested, "recovery-required", 1, "coordination-failed", "orphaned upgrade intent could not resume Home", "retry-recovery", {
        selected: selectedArtifact, recovered: true, service,
      }));
    }
    return resultValue(output({
      vault,
      requested,
      selected: selectedArtifact,
      status: "recovered-rerun-required",
      exitCode: 1,
      recovered: true,
      service,
      reason: "prior-attempt-recovered",
      nextAction: "rerun-requested-upgrade",
      message: `Recovered orphaned upgrade operation ${suspension.suspension.operationId}; rerun the requested upgrade.`,
    }));
  }
  if (active === null) {
    if (suspension.kind === "active") {
      return resultValue(failure(vault, requested, "recovery-required", 1, "coordination-failed", "active lifecycle evidence changed during upgrade preflight", "retry-recovery", {
        selected: selectedArtifact,
      }));
    }
    return Object.freeze({ kind: "continue" as const });
  }
  if (suspension.kind === "active" &&
    (suspension.suspension.purpose !== "upgrade" || suspension.suspension.operationId !== active.transactionId)) {
    return resultValue(failure(vault, requested, "recovery-required", 1, "coordination-failed", "lifecycle and upgrade transaction ownership disagree", "retry-recovery", {
      selected: selectedArtifact,
    }));
  }

  const sameIdentity = active.candidate.artifactId === requested.artifactId &&
    active.candidate.version === requested.productVersion;
  let sameRequested = sameIdentity;
  if (active.phase === "committed" && sameIdentity) {
    try {
      await operations.inspectRepair({
        vaultPath: vault,
        transactionId: active.transactionId,
        candidate: repairCandidate,
      }, deps);
    } catch {
      return resultValue(failure(
        vault,
        requested,
        "recovery-required",
        1,
        "candidate-repair-required",
        "invoking artifact is not the exact committed candidate",
        "supply-exact-candidate",
        { transaction: active, selected: selectedArtifact },
      ));
    }
    sameRequested = true;
  }
  if (suspension.kind === "inactive" && (active.phase === "prepared" || active.phase === "switching")) {
    return resultValue(failure(
      vault,
      requested,
      "recovery-required",
      1,
      "coordination-failed",
      "pre-commit Dome Home upgrade lacks its lifecycle suspension; refusing unsafe rollback",
      "retry-recovery",
      {
        transaction: active,
        selected: selectedArtifact,
      },
    ));
  }
  if (suspension.kind === "inactive" && active.phase === "restored") {
    if (!sameRequested) {
      await operations.retire({ vaultPath: vault, transactionId: active.transactionId }, deps);
      return Object.freeze({ kind: "continue" as const });
    }
    return resultValue(await finalizeRestored(vault, requested, active, false, deps, operations));
  }
  if (suspension.kind === "inactive" && active.phase === "committed") {
    if (!sameIdentity) {
      try {
        const forward = await operations.readForward(vault, deps);
        if (forward === null || forward.transactionId !== active.transactionId) {
          throw new Error("committed forward evidence is unavailable");
        }
      } catch {
        return resultValue(failure(
          vault,
          requested,
          "recovery-required",
          1,
          "candidate-repair-required",
          "exact invoking committed candidate is required for forward repair",
          "supply-exact-candidate",
          { transaction: active, selected: selectedArtifact },
        ));
      }
    }
    try {
      await operations.retire({ vaultPath: vault, transactionId: active.transactionId }, deps);
      if (!sameRequested) return Object.freeze({ kind: "continue" as const });
      const service = await operations.inspectService(vault, deps);
      if (service !== "ready" && service !== "stopped") {
        return resultValue(failure(vault, requested, "recovery-required", 1, "coordination-failed", "committed Dome Home is not ready or stopped", "inspect-home-status", {
          transaction: active,
          selected: artifactSummary(active.candidate.artifactId, active.candidate.version),
          recovered: true,
          service,
        }));
      }
      return resultValue(output({
        vault,
        requested,
        selected: artifactSummary(active.candidate.artifactId, active.candidate.version),
        transaction: active,
        status: "already-current",
        exitCode: 0,
        recovered: true,
        service,
        message: "The invoking Dome Home artifact was already committed.",
      }));
    } catch {
      // Not yet terminal-healthy: the journal-bound cutover below performs
      // the one permitted forward recovery disposition.
    }
  }

  const cutover = await operations.cutover({
    vaultPath: vault,
    transactionId: active.transactionId,
    candidateArtifactId: active.candidate.artifactId,
    expectedCurrentArtifactId: active.old.artifactId,
    repairCandidate,
  }, deps);
  return resultValue(await finalizeCutover(vault, requested, cutover, !sameRequested, deps, operations));
}

async function finalizeRestored(
  vault: string,
  requested: HomeUpgradeArtifactSummary,
  transaction: HomeUpgradeTransaction,
  rerun: boolean,
  deps: HomeUpgradeIntentDeps,
  operations: IntentOperations,
): Promise<HomeUpgradeResult> {
  try {
    await operations.retire({ vaultPath: vault, transactionId: transaction.transactionId }, deps);
  } catch {
    return failure(vault, requested, "recovery-required", 1, "coordination-failed", "upgrade rollback needs finalization", "inspect-home-status", {
      transaction,
      selected: artifactSummary(transaction.old.artifactId, transaction.old.version),
      recovered: true,
    });
  }
  const service = await operations.inspectService(vault, deps);
  return terminalResult({
    vault,
    requested,
    selected: artifactSummary(transaction.old.artifactId, transaction.old.version),
    transaction,
    status: rerun ? "recovered-rerun-required" : "rolled-back",
    recovered: true,
    service,
    reason: rerun ? "prior-attempt-recovered" : "candidate-failed",
    message: rerun
      ? "Recovered a prior upgrade attempt; rerun the requested artifact."
      : "The requested Dome Home artifact was rolled back.",
  });
}

async function finalizeCutover(
  vault: string,
  requested: HomeUpgradeArtifactSummary,
  cutover: HomeUpgradeCutoverResult,
  rerun: boolean,
  deps: HomeUpgradeIntentDeps,
  operations: IntentOperations,
): Promise<HomeUpgradeResult> {
  const transaction = cutover.transactionOutcome.transaction;
  const selected = transaction.phase === "committed"
    ? artifactSummary(transaction.candidate.artifactId, transaction.candidate.version)
    : artifactSummary(transaction.old.artifactId, transaction.old.version);
  const service = serviceFromLifecycle(cutover.lifecycle);
  if (cutover.status !== "ready") {
    const exactCandidateRequired = transaction.phase === "committed" &&
      cutover.handoffError === "exact invoking committed candidate is required for forward repair";
    return failure(
      vault,
      requested,
      "recovery-required",
      1,
      exactCandidateRequired ? "candidate-repair-required" : "coordination-failed",
      exactCandidateRequired
        ? "exact invoking committed candidate is required for forward repair"
        : "Dome Home upgrade handoff requires recovery",
      exactCandidateRequired ? "supply-exact-candidate" : "retry-recovery",
      {
      transaction,
      selected,
      recovered: cutover.lifecycle.recovered,
      service,
      },
    );
  }
  try {
    await operations.retire({ vaultPath: vault, transactionId: transaction.transactionId }, deps);
  } catch {
    return failure(vault, requested, "recovery-required", 1, "coordination-failed", "terminal upgrade needs finalization", "inspect-home-status", {
      transaction,
      selected,
      recovered: cutover.lifecycle.recovered,
      service,
    });
  }
  const rolledBack = cutover.transactionOutcome.kind === "rolled-back";
  return terminalResult({
    vault,
    requested,
    selected,
    transaction,
    status: rerun ? "recovered-rerun-required" : rolledBack ? "rolled-back" : "upgraded",
    recovered: cutover.lifecycle.recovered || rerun,
    service,
    reason: rerun ? "prior-attempt-recovered" : rolledBack ? "candidate-failed" : null,
    message: rerun
      ? "Recovered a prior upgrade attempt; rerun the requested artifact."
      : rolledBack
      ? "The requested Dome Home artifact was rolled back."
      : "Dome Home upgraded successfully.",
  });
}

function terminalResult(input: {
  readonly vault: string;
  readonly requested: HomeUpgradeArtifactSummary;
  readonly selected: HomeUpgradeArtifactSummary;
  readonly transaction: HomeUpgradeTransaction;
  readonly status: "upgraded" | "rolled-back" | "recovered-rerun-required";
  readonly recovered: boolean;
  readonly service: HomeUpgradeResult["service"];
  readonly reason: HomeUpgradeResult["reason"];
  readonly message: string;
}): HomeUpgradeResult {
  const success = input.status === "upgraded" && (input.service === "ready" || input.service === "stopped");
  return output({
    ...input,
    exitCode: success ? 0 : 1,
    nextAction: input.status === "recovered-rerun-required" ? "rerun-requested-upgrade" : "none",
  });
}

function failure(
  vault: string,
  requested: HomeUpgradeArtifactSummary | null,
  status: "error" | "recovery-required",
  exitCode: 1 | 64 | 75,
  reason: Exclude<HomeUpgradeResult["reason"], null>,
  detail: string,
  nextAction: HomeUpgradeResult["nextAction"],
  extra: {
    readonly transaction?: HomeUpgradeTransaction | undefined;
    readonly selected?: HomeUpgradeArtifactSummary | null | undefined;
    readonly recovered?: boolean | undefined;
    readonly service?: HomeUpgradeResult["service"] | undefined;
  } = {},
): HomeUpgradeResult {
  return output({
    vault,
    requested,
    selected: extra.selected ?? null,
    transaction: extra.transaction,
    status,
    exitCode,
    recovered: extra.recovered ?? false,
    service: extra.service ?? "unknown",
    reason,
    nextAction,
    message: detail,
  });
}

function output(input: {
  readonly vault: string;
  readonly requested: HomeUpgradeArtifactSummary | null;
  readonly selected: HomeUpgradeArtifactSummary | null;
  readonly transaction?: HomeUpgradeTransaction | HomeUpgradeHistorySummary | undefined;
  readonly status: HomeUpgradeResult["status"];
  readonly exitCode: HomeUpgradeResult["exitCode"];
  readonly recovered?: boolean | undefined;
  readonly service: HomeUpgradeResult["service"];
  readonly reason?: HomeUpgradeResult["reason"] | undefined;
  readonly message: string;
  readonly nextAction?: HomeUpgradeResult["nextAction"] | undefined;
}): HomeUpgradeResult {
  return Object.freeze({
    schema: HOME_UPGRADE_RESULT_SCHEMA,
    operation: "upgrade" as const,
    status: input.status,
    exitCode: input.exitCode,
    vault: input.vault,
    requestedArtifact: input.requested,
    transaction: input.transaction === undefined ? null : transactionSummary(input.transaction),
    selectedArtifact: input.selected,
    recovered: input.recovered ?? false,
    service: input.service,
    reason: input.reason ?? null,
    message: input.message,
    nextAction: input.nextAction ?? "none",
  });
}

function resultValue(value: HomeUpgradeResult): { readonly kind: "result"; readonly value: HomeUpgradeResult } {
  return Object.freeze({ kind: "result" as const, value });
}

function transactionSummary(
  transaction: HomeUpgradeTransaction | HomeUpgradeHistorySummary,
): NonNullable<HomeUpgradeResult["transaction"]> {
  if ("operationId" in transaction) {
    return Object.freeze({
      operationId: transaction.operationId,
      candidate: transaction.candidate,
      outcome: transaction.outcome,
    });
  }
  return Object.freeze({
    operationId: transaction.transactionId,
    candidate: artifactSummary(transaction.candidate.artifactId, transaction.candidate.version),
    outcome: transaction.phase === "committed" ? "committed" as const : "restored" as const,
  });
}

function artifactSummary(artifactId: string, productVersion: string): HomeUpgradeArtifactSummary {
  return Object.freeze({ artifactId, productVersion });
}

function installationSummary(record: HomeInstallationRecord): HomeUpgradeArtifactSummary {
  return artifactSummary(record.artifact.id, record.artifact.version);
}

function sameArtifact(left: HomeUpgradeArtifactSummary, right: HomeUpgradeArtifactSummary): boolean {
  return left.artifactId === right.artifactId && left.productVersion === right.productVersion;
}

function serviceFromLifecycle(result: SupervisedHomeSuspensionResult<unknown>): HomeUpgradeResult["service"] {
  if (result.kind === "ready") return "ready";
  if (result.kind === "not-required") return "stopped";
  if (result.kind === "deferred") return "deferred";
  return "failed";
}

function resolveOperations(overrides: Partial<IntentOperations> | undefined): IntentOperations {
  return Object.freeze({
    canonicalizeVault: overrides?.canonicalizeVault ?? (async (path) => realpath(path)),
    verifyInvokingArtifact: overrides?.verifyInvokingArtifact ?? verifyHomeArtifact,
    publishCandidate: overrides?.publishCandidate ?? ensureManagedRelease,
    readInstallation: overrides?.readInstallation ?? readHomeInstallation,
    inspectLifecycle: overrides?.inspectLifecycle ?? inspectHomeLifecycleSuspension,
    readActive: overrides?.readActive ?? readHomeUpgradeDisposition,
    readCandidateReceipt: overrides?.readCandidateReceipt ?? readHomeUpgradeCandidateReceipt,
    readForward: overrides?.readForward ?? readCommittedHomeUpgradeForward,
    inspectRepair: overrides?.inspectRepair ?? inspectCommittedHomeUpgradeRepair,
    cutover: overrides?.cutover ?? runHomeUpgradeCutover,
    retire: overrides?.retire ?? retireHomeUpgrade,
    recoverOrphan: overrides?.recoverOrphan ?? (async (vaultPath, operationId, deps) =>
      withSupervisedHomeSuspended({
        mode: "recover",
        vaultPath,
        purpose: "upgrade",
        operationId,
        policy: "resume-only",
      }, async () => {}, deps)),
    inspectService: overrides?.inspectService ?? inspectService,
    operationId: overrides?.operationId ?? randomUUID,
  });
}

async function inspectService(vaultPath: string, deps: HomeUpgradeIntentDeps): Promise<HomeUpgradeResult["service"]> {
  const status = await manageHome({ action: "status", vaultPath }, deps);
  if (status.status === "ready" && status.loaded === true && status.ready === true) return "ready";
  if (status.status === "installed-stopped" && status.loaded === false && status.installed === true) return "stopped";
  return status.loaded === true ? "failed" : "unknown";
}
