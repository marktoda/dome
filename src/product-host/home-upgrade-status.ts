// product-host/home-upgrade-status: phase-free, read-only projection of the
// current upgrade transaction for lifecycle and future product surfaces.

import {
  readCommittedHomeUpgradeForward,
  readHomeUpgradeDisposition,
  type HomeUpgradeTransaction,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";

export type HomeUpgradeLifecycleSummary = {
  readonly state: "inactive" | "active" | "complete" | "recovery-required" | "unavailable";
  readonly candidate: {
    readonly artifactId: string;
    readonly productVersion: string;
  } | null;
  readonly operationId: string | null;
  readonly outcome: "committed" | "restored" | null;
  readonly nextAction: "none" | "rerun-requested-upgrade" | "retry-recovery" | "supply-exact-candidate" | "inspect-home-status";
};

type HomeUpgradeStatusOperations = {
  readonly readDisposition: typeof readHomeUpgradeDisposition;
  readonly readForward: typeof readCommittedHomeUpgradeForward;
};

export type HomeUpgradeStatusDeps = HomeUpgradeTransactionDeps & {
  /** One read-only seam for projection decision-table tests. */
  readonly upgradeStatusOperations?: Partial<HomeUpgradeStatusOperations> | undefined;
};

/**
 * Summarize only the current transaction. Retired terminal evidence belongs to
 * upgrade history, so a missing active journal is deliberately `inactive`.
 */
export async function inspectHomeUpgradeStatus(
  vaultPath: string,
  deps: HomeUpgradeStatusDeps = {},
): Promise<HomeUpgradeLifecycleSummary> {
  const operations: HomeUpgradeStatusOperations = {
    readDisposition: deps.upgradeStatusOperations?.readDisposition ?? readHomeUpgradeDisposition,
    readForward: deps.upgradeStatusOperations?.readForward ?? readCommittedHomeUpgradeForward,
  };
  let transaction: HomeUpgradeTransaction | null;
  try { transaction = await operations.readDisposition(vaultPath, deps); }
  catch { return unavailable(); }
  if (transaction === null) return inactive();
  if (transaction.phase === "prepared" || transaction.phase === "switching") {
    return summary(transaction, "active", null, "retry-recovery");
  }
  if (transaction.phase === "restored") {
    return summary(transaction, "complete", "restored", "none");
  }
  try {
    const forward = await operations.readForward(vaultPath, deps);
    if (forward === null) return inactive();
    if (forward.transactionId !== transaction.transactionId ||
      forward.candidate.artifactId !== transaction.candidate.artifactId ||
      forward.candidate.version !== transaction.candidate.version) {
      return unavailable();
    }
    return summary(forward, "complete", "committed", "none");
  } catch {
    let current: HomeUpgradeTransaction | null;
    try { current = await operations.readDisposition(vaultPath, deps); }
    catch { return unavailable(); }
    if (current === null) return inactive();
    if (!sameIdentity(current, transaction)) return unavailable();
    if (current.phase !== "committed") return unavailable();
    return summary(current, "recovery-required", "committed", "supply-exact-candidate");
  }
}

function sameIdentity(left: HomeUpgradeTransaction, right: HomeUpgradeTransaction): boolean {
  return left.transactionId === right.transactionId &&
    left.candidate.artifactId === right.candidate.artifactId &&
    left.candidate.version === right.candidate.version;
}

function summary(
  transaction: HomeUpgradeTransaction,
  state: HomeUpgradeLifecycleSummary["state"],
  outcome: HomeUpgradeLifecycleSummary["outcome"],
  nextAction: HomeUpgradeLifecycleSummary["nextAction"],
): HomeUpgradeLifecycleSummary {
  return Object.freeze({
    state,
    candidate: Object.freeze({
      artifactId: transaction.candidate.artifactId,
      productVersion: transaction.candidate.version,
    }),
    operationId: transaction.transactionId,
    outcome,
    nextAction,
  });
}

function inactive(): HomeUpgradeLifecycleSummary {
  return Object.freeze({ state: "inactive", candidate: null, operationId: null, outcome: null, nextAction: "none" });
}

function unavailable(): HomeUpgradeLifecycleSummary {
  return Object.freeze({ state: "unavailable", candidate: null, operationId: null, outcome: null, nextAction: "inspect-home-status" });
}
