// product-host/home-lifecycle-suspension: crash-honest quiescence for the
// supervised macOS Home. A tiny ownership database provides the kernel lock;
// a separate rollback-journal database can durably advance recovery evidence
// while that outer lock remains held.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  acquireOperationalWriterLease,
  type OperationalWriterAdmissionError,
  type OperationalWriterLease,
} from "../operational-state/writer-barrier";
import {
  activateLaunchAgent,
  probeLaunchAgentLoadedStrict,
  waitForLaunchAgentDrainStrict,
} from "../platform/launchd";
import { resolveServiceDeps, serviceLabelForVault, vaultServiceSlug, type ServiceDeps } from "../surface/service-probe";
import { readServeHeartbeatStatus } from "../engine/host/compiler-host-heartbeat";
import {
  homeInstallationPaths,
  readHomeInstallation,
  releaseRoot,
  type HomeInstallationDeps,
} from "./home-installation";
import { verifyHomeArtifact } from "./home-artifact";
import { isHomePairingReadiness } from "./home-readiness";

export const HOME_LIFECYCLE_SUSPENSION_SCHEMA =
  "dome.home-lifecycle-suspension/v1" as const;
const OWNERSHIP_SCHEMA = "dome.home-lifecycle-suspension-ownership/v1" as const;
const JOURNAL_TABLE = "home_lifecycle_suspension";
const OWNERSHIP_TABLE = "home_lifecycle_suspension_ownership";
const JOURNAL_NAME = "home-lifecycle-suspension.db";
const OWNERSHIP_NAME = "home-lifecycle-suspension-ownership.db";
const STORAGE_NAME = "home-lifecycle-suspension";
const LAYOUT_NAME = "layout.json";
const LAYOUT_SCHEMA = "dome.home-lifecycle-suspension-layout/v1" as const;
const ESTABLISHMENT_NAME = "home-lifecycle-suspension.established";
const ESTABLISHMENT_SCHEMA = "dome.home-lifecycle-suspension-establishment/v1" as const;
const BUSY_SLICE_MS = 25;
const OWNERSHIP_WAIT_MS = 30_000;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LAYOUT_ID = /^[a-f0-9]{32}$/;

const OWNERSHIP_DDL = `CREATE TABLE ${OWNERSHIP_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (schema = '${OWNERSHIP_SCHEMA}'),
  layout_state TEXT NOT NULL CHECK (layout_state = 'ready')
) STRICT`;

const JOURNAL_DDL = `CREATE TABLE ${JOURNAL_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (schema = '${HOME_LIFECYCLE_SUSPENSION_SCHEMA}'),
  phase TEXT NOT NULL CHECK (phase IN ('suspending', 'suspended', 'resuming')),
  purpose TEXT NOT NULL CHECK (purpose IN ('backup', 'upgrade')),
  operation_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  prior_loaded INTEGER NOT NULL CHECK (prior_loaded IN (0, 1)),
  installation_path TEXT NOT NULL,
  installation_sha256 TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  plist_path TEXT NOT NULL,
  plist_sha256 TEXT NOT NULL,
  resume_installation_path TEXT NOT NULL,
  resume_installation_sha256 TEXT NOT NULL,
  resume_artifact_id TEXT NOT NULL,
  resume_artifact_version TEXT NOT NULL,
  resume_plist_path TEXT NOT NULL,
  resume_plist_sha256 TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  phase_changed_at TEXT NOT NULL,
  last_error TEXT
) STRICT`;

export type HomeSuspensionPurpose = "backup" | "upgrade";
export type HomeSuspensionPhase = "suspending" | "suspended" | "resuming";

export type HomeLifecycleSuspension = {
  readonly schema: typeof HOME_LIFECYCLE_SUSPENSION_SCHEMA;
  readonly phase: HomeSuspensionPhase;
  readonly purpose: HomeSuspensionPurpose;
  readonly operationId: string;
  readonly vault: string;
  readonly priorLoaded: boolean;
  readonly installationPath: string;
  readonly installationSha256: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly plistPath: string;
  readonly plistSha256: string;
  readonly resumeInstallationPath: string;
  readonly resumeInstallationSha256: string;
  readonly resumeArtifactId: string;
  readonly resumeArtifactVersion: string;
  readonly resumePlistPath: string;
  readonly resumePlistSha256: string;
  readonly requestedAt: string;
  readonly phaseChangedAt: string;
  readonly lastError: string | null;
};

export type HomeLifecycleSuspensionInspection =
  | { readonly kind: "inactive" }
  | { readonly kind: "active"; readonly suspension: HomeLifecycleSuspension }
  | { readonly kind: "unavailable"; readonly error: string }
  | { readonly kind: "invalid"; readonly error: string };

export type HomeLifecycleMutationResult<T> =
  | { readonly kind: "owned"; readonly value: T }
  | { readonly kind: "suspended"; readonly suspension: HomeLifecycleSuspension };

export type HomeLifecycleMutationDeps = {
  /** Test/diagnostic seam for the incomplete-establishment validation race. */
  readonly beforeEstablishmentJournalRead?: (() => Promise<void>) | undefined;
};

export type HomeStartupAdmission =
  | { readonly ok: true; readonly lease: OperationalWriterLease }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: "lifecycle-closed" | "resume-evidence-invalid" | "operational-admission-closed" | "coordination-failed";
        readonly message: string;
        readonly operationId?: string | undefined;
      };
    };

export type HomeStartupAdmissionDeps = Pick<
  HomeInstallationDeps,
  "applicationSupportDir" | "verifyArtifact"
> & Pick<ServiceDeps, "launchAgentsDir"> & {
  /** Internal provenance inputs; production uses the actual Bun/script paths. */
  readonly invokingRuntimePath?: string | undefined;
  readonly invokingEntrypointPath?: string | undefined;
  /** Test-only race seams inside this Module. */
  readonly beforeInactiveOperationalLease?: (() => Promise<void>) | undefined;
  readonly afterResumingOperationalLease?: (() => Promise<void>) | undefined;
};

type SuspensionResultBase<T> = {
  readonly operationId: string;
  readonly recovered: boolean;
  readonly operationRan: boolean;
  readonly value?: T;
};

export type SupervisedHomeSuspensionResult<T> =
  | (SuspensionResultBase<T> & { readonly kind: "not-required" })
  | (SuspensionResultBase<T> & { readonly kind: "ready" })
  | (SuspensionResultBase<T> & {
      readonly kind: "deferred";
      readonly reason: "write-barrier-closed";
      readonly transactionId: string;
    })
  | (SuspensionResultBase<T> & {
      readonly kind: "failed";
      readonly error: string;
    });

export type HomeLifecycleSuspensionDeps = ServiceDeps & HomeInstallationDeps & {
  readonly readiness?: (() => Promise<boolean>) | undefined;
  readonly readinessTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly legacyServeRunning?: (() => Promise<boolean>) | undefined;
  /** Test/diagnostic crash seam; production leaves this absent. */
  readonly checkpoint?: ((name: "intent-committed" | "callback-returned" | "readiness-proven") => Promise<void>) | undefined;
};

export type HomeSuspensionRecoveryPolicy =
  /** Abort/recover only: finish drain and resume without invoking work. */
  | "resume-only"
  /** Callback is idempotent and keyed by operationId; crash gap is at-least-once. */
  | "retry-idempotent"
  /** Same at-least-once gap, plus an external exact upgrade-journal authorizer. */
  | "authorized-upgrade-continuation";

export type HomeSuspensionInvocation =
  | {
      readonly mode: "new";
      readonly vaultPath: string;
      readonly purpose: HomeSuspensionPurpose;
      readonly operationId?: string | undefined;
    }
  | {
      readonly mode: "recover";
      readonly vaultPath: string;
      readonly purpose: HomeSuspensionPurpose;
      readonly operationId: string;
      readonly policy: HomeSuspensionRecoveryPolicy;
      /** Required external upgrade-journal authorization; this Module cannot infer it. */
      readonly authorizeContinuation?: ((active: HomeLifecycleSuspension) => Promise<HomeResumeAuthorization>) | undefined;
    };

export type HomeResumeAuthorization = {
  readonly operationId: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly installationSha256: string;
  readonly plistSha256: string;
};

export type HomeSuspensionOperationContext = {
  readonly operationId: string;
  readonly purpose: HomeSuspensionPurpose;
  /** Durably seal the currently selected Home as the only resume target. */
  readonly authorizeCurrentHomeForResume: () => Promise<void>;
};

type JournalRow = {
  readonly singleton: number;
  readonly schema: string;
  readonly phase: string;
  readonly purpose: string;
  readonly operation_id: string;
  readonly vault: string;
  readonly prior_loaded: number;
  readonly installation_path: string;
  readonly installation_sha256: string;
  readonly artifact_id: string;
  readonly artifact_version: string;
  readonly plist_path: string;
  readonly plist_sha256: string;
  readonly resume_installation_path: string;
  readonly resume_installation_sha256: string;
  readonly resume_artifact_id: string;
  readonly resume_artifact_version: string;
  readonly resume_plist_path: string;
  readonly resume_plist_sha256: string;
  readonly requested_at: string;
  readonly phase_changed_at: string;
  readonly last_error: string | null;
};

type Evidence = Pick<HomeLifecycleSuspension,
  "installationPath" | "installationSha256" | "artifactId" |
  "artifactVersion" | "plistPath" | "plistSha256">;

export function homeLifecycleCoordinatorPath(vaultPath: string): string {
  return coordinatorPaths(canonicalVault(vaultPath)).journal;
}

/** Read-only diagnosis. Partial, corrupt, redirected, or foreign state is invalid. */
export async function inspectHomeLifecycleSuspension(
  vaultPath: string,
): Promise<HomeLifecycleSuspensionInspection> {
  let vault: string;
  try { vault = await realpath(resolve(vaultPath)); }
  catch (error) { return Object.freeze({ kind: "invalid", error: message(error) }); }
  const paths = coordinatorPaths(vault);
  const rootPresent = pathPresent(paths.root);
  const establishmentPresent = pathPresent(paths.establishmentRoot);
  if (!rootPresent && !establishmentPresent) return Object.freeze({ kind: "inactive" });
  if (!rootPresent) {
    return Object.freeze({ kind: "invalid", error: "established Home lifecycle coordinator root is missing" });
  }
  let layout: LayoutMarker;
  try {
    validateDirectPrivateDirectory(paths.root);
    layout = readLayoutMarker(paths.layout);
  } catch (error) {
    return Object.freeze({ kind: "invalid", error: message(error) });
  }
  if (!establishmentPresent) {
    try {
      const rootState = await validateUnestablishedRoot(paths, vault);
      if (!pathPresent(paths.establishmentRoot) && rootState === "active") {
        return Object.freeze({ kind: "invalid", error: "active Home lifecycle coordinator is missing immutable establishment evidence" });
      }
      if (!pathPresent(paths.establishmentRoot)) {
        return Object.freeze({ kind: "unavailable", error: "Home lifecycle coordinator establishment is incomplete" });
      }
    } catch (error) {
      if (isBusy(error)) return Object.freeze({ kind: "unavailable", error: "Home lifecycle coordinator is busy" });
      return Object.freeze({ kind: "invalid", error: message(error) });
    }
  }
  try {
    const establishment = readEstablishmentMarker(paths);
    if (establishment.layoutId !== layout.layoutId) {
      return Object.freeze({ kind: "invalid", error: "Home lifecycle coordinator establishment layout id does not match its root" });
    }
  } catch (error) {
    return Object.freeze({ kind: "invalid", error: message(error) });
  }
  const journalExists = pathPresent(paths.journal);
  const ownershipExists = pathPresent(paths.ownership);
  if (!journalExists && !ownershipExists) {
    return Object.freeze({ kind: "invalid", error: "Home lifecycle coordinator databases are missing from a ready layout" });
  }
  if (!ownershipExists) {
    return Object.freeze({ kind: "invalid", error: "Home lifecycle ownership coordinator is missing from an established layout" });
  }
  try {
    validateExistingCoordinatorFile(paths.ownership, "ownership");
    const ownership = await openEstablishedForInspection(paths.ownership, OWNERSHIP_DDL, validateOwnershipRow);
    try {
      readOwnershipLayout(ownership);
      if (!journalExists) {
        return Object.freeze({ kind: "invalid", error: "Home lifecycle journal coordinator is missing from a ready layout" });
      }
      validateExistingCoordinatorFile(paths.journal, "journal");
      const journal = await openEstablishedForInspection(paths.journal, JOURNAL_DDL, () => {});
      try {
        const active = readActive(journal, vault);
        return active === null
          ? Object.freeze({ kind: "inactive" as const })
          : Object.freeze({ kind: "active" as const, suspension: active });
      } finally { journal.close(); }
    } finally { ownership.close(); }
  } catch (error) {
    if (isBusy(error)) {
      return Object.freeze({ kind: "unavailable", error: "Home lifecycle coordinator is busy" });
    }
    return Object.freeze({ kind: "invalid", error: message(error) });
  }
}

/**
 * The sole lifecycle-mutation ownership seam. The callback runs while
 * BEGIN IMMEDIATE is held; an active durable suspension denies it.
 */
export async function withHomeLifecycleMutation<T>(
  vaultPath: string,
  operation: () => Promise<T>,
  deps: HomeLifecycleMutationDeps = {},
): Promise<HomeLifecycleMutationResult<T>> {
  const vault = await realpath(resolve(vaultPath));
  const pair = await openCoordinatorPair(vault, deps.beforeEstablishmentJournalRead);
  try {
    // Fast denial avoids waiting behind a suspension's long Tx2. The second
    // read under ownership closes the race with a concurrently publishing Tx1.
    const published = readActive(pair.journal, vault);
    if (published !== null) {
      return Object.freeze({ kind: "suspended" as const, suspension: published });
    }
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    const active = readActive(pair.journal, vault);
    if (active !== null) {
      pair.ownership.run("ROLLBACK");
      return Object.freeze({ kind: "suspended" as const, suspension: active });
    }
    const value = await operation();
    pair.ownership.run("COMMIT");
    return Object.freeze({ kind: "owned" as const, value });
  } catch (error) {
    rollback(pair.ownership);
    throw error;
  } finally {
    closePair(pair);
  }
}

/**
 * Atomically admit a normal Product Host startup. The returned operational
 * lease belongs to the caller for the host's complete lifetime.
 */
export async function acquireHomeStartupAdmission(input: {
  readonly vaultPath: string;
  readonly launchArtifact: { readonly id: string; readonly version: string };
}, deps: HomeStartupAdmissionDeps = {}): Promise<HomeStartupAdmission> {
  let vault: string;
  try { vault = await realpath(resolve(input.vaultPath)); }
  catch (error) { return startupDenied("coordination-failed", message(error)); }

  let pair: CoordinatorPair;
  try { pair = await openCoordinatorPair(vault); }
  catch (error) { return startupDenied("coordination-failed", message(error)); }
  let result: HomeStartupAdmission;
  try {
    result = await decideHomeStartupAdmission(vault, input.launchArtifact, pair, deps);
  } catch (error) {
    result = startupDenied("coordination-failed", message(error));
  }
  try { closePair(pair); }
  catch (error) {
    if (result.ok) result.lease.close();
    return startupDenied("coordination-failed", `Home lifecycle coordinator close failed: ${message(error)}`);
  }
  return result;
}

async function decideHomeStartupAdmission(
  vault: string,
  launchArtifact: { readonly id: string; readonly version: string },
  pair: CoordinatorPair,
  deps: HomeStartupAdmissionDeps,
): Promise<HomeStartupAdmission> {
  // A supervisor holds Tx2 while a resuming child proves readiness. Reading
  // the durable row first avoids waiting on the very parent awaiting us.
  const published = readActive(pair.journal, vault);
  if (published !== null) {
    if (published.phase === "resuming") {
      return admitResumingStartup(vault, published, launchArtifact, pair, deps);
    }
    return startupDenied(
      "lifecycle-closed",
      `Home lifecycle is ${published.phase} for a ${published.purpose} operation`,
      published.operationId,
    );
  }

  let lease: OperationalWriterLease | null = null;
  try {
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    const active = readActive(pair.journal, vault);
    if (active !== null) {
      pair.ownership.run("ROLLBACK");
      return startupDenied(
        "lifecycle-closed",
        `Home lifecycle is ${active.phase} for a ${active.purpose} operation`,
        active.operationId,
      );
    }
    await deps.beforeInactiveOperationalLease?.();
    const operational = await acquireOperationalWriterLease({
      vaultPath: vault,
      command: "dome-product-host",
    });
    if (!operational.ok) {
      pair.ownership.run("ROLLBACK");
      return startupDenied(
        "operational-admission-closed",
        operationalAdmissionMessage(operational.error),
      );
    }
    lease = operational.lease;
    pair.ownership.run("COMMIT");
    return Object.freeze({ ok: true as const, lease });
  } catch (error) {
    lease?.close();
    rollback(pair.ownership);
    return startupDenied("coordination-failed", message(error));
  }
}

async function admitResumingStartup(
  vault: string,
  active: HomeLifecycleSuspension,
  launchArtifact: { readonly id: string; readonly version: string },
  pair: CoordinatorPair,
  deps: HomeStartupAdmissionDeps,
): Promise<HomeStartupAdmission> {
  if (!active.priorLoaded) {
    return startupDenied(
      "resume-evidence-invalid",
      "a prior-stopped Home suspension cannot admit a resuming child",
      active.operationId,
    );
  }
  if (!SHA256.test(launchArtifact.id) ||
    launchArtifact.id !== active.resumeArtifactId ||
    launchArtifact.version !== active.resumeArtifactVersion) {
    return startupDenied(
      "resume-evidence-invalid",
      "normal launch artifact does not match the authorized Home resume target",
      active.operationId,
    );
  }

  let before: Evidence;
  try {
    before = await captureStartupEvidence(vault, deps);
    if (!sameResumeEvidence(active, before)) {
      throw new Error("current Home installation or plist does not match the authorized resume target");
    }
  } catch (error) {
    return startupDenied("resume-evidence-invalid", message(error), active.operationId);
  }

  const operational = await acquireOperationalWriterLease({
    vaultPath: vault,
    command: "dome-product-host-resuming",
  });
  if (!operational.ok) {
    return startupDenied(
      "operational-admission-closed",
      operationalAdmissionMessage(operational.error),
      active.operationId,
    );
  }
  try {
    await deps.afterResumingOperationalLease?.();
    const current = readActive(pair.journal, vault);
    if (current === null || !sameActive(current, active)) {
      throw new Error("Home lifecycle resume evidence changed during startup admission");
    }
    const after = await captureStartupEvidence(vault, deps);
    if (!sameEvidence(before, after) || !sameResumeEvidence(current, after)) {
      throw new Error("Home installation or plist evidence changed during startup admission");
    }
    await verifyStartupProvenance(vault, launchArtifact, deps);
    const finalActive = readActive(pair.journal, vault);
    if (finalActive === null || !sameActive(finalActive, active)) {
      throw new Error("Home lifecycle resume evidence changed while verifying startup provenance");
    }
    const finalEvidence = await captureStartupEvidence(vault, deps);
    if (!sameEvidence(after, finalEvidence) || !sameResumeEvidence(finalActive, finalEvidence)) {
      throw new Error("Home installation or plist evidence changed while verifying startup provenance");
    }
    const settledActive = readActive(pair.journal, vault);
    if (settledActive === null || !sameActive(settledActive, active)) {
      throw new Error("Home lifecycle resume evidence changed before startup lease publication");
    }
    return Object.freeze({ ok: true as const, lease: operational.lease });
  } catch (error) {
    operational.lease.close();
    return startupDenied("resume-evidence-invalid", message(error), active.operationId);
  }
}

/**
 * Bracket a quiesced operation. Durable phase transitions use the journal
 * connection while Tx2 holds the ownership database's kernel writer lock.
 */
export async function withSupervisedHomeSuspended<T>(
  input: HomeSuspensionInvocation,
  operation: (context: HomeSuspensionOperationContext) => Promise<T>,
  deps: HomeLifecycleSuspensionDeps = {},
): Promise<SupervisedHomeSuspensionResult<T>> {
  const vault = await realpath(resolve(input.vaultPath));
  const requestedOperationId = input.mode === "new"
    ? input.operationId ?? randomUUID()
    : input.operationId;
  assertOperationId(requestedOperationId);
  if (input.mode === "new" && input.purpose === "upgrade" && input.operationId === undefined) {
    throw new Error("upgrade suspension requires an explicit operation id");
  }
  validateRecoveryInvocation(input);
  const service = resolveServiceDeps(deps);
  if (service.platform !== "darwin" || service.uid === null) {
    throw new Error("supervised Home suspension requires macOS launchd");
  }
  const label = `com.dome.home.${vaultServiceSlug(vault)}`;
  const target = `gui/${service.uid}/${label}`;
  const pair = await openCoordinatorPair(vault);
  let active: HomeLifecycleSuspension;
  let recovered = false;
  try {
    // Tx1 owns the lifecycle seam before observing any mutable evidence.
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    const existing = readActive(pair.journal, vault);
    if (existing === null) {
      const evidence = await captureEvidence(vault, service.launchAgentsDir, deps);
      const priorLoaded = await probeLaunchAgentLoadedStrict({ launchctl: service.launchctl, target });
      await assertNoCompetingHost(vault, priorLoaded, service, deps);
      const now = exactTimestamp((deps.now ?? (() => new Date()))());
      active = Object.freeze({
        schema: HOME_LIFECYCLE_SUSPENSION_SCHEMA,
        phase: "suspending",
        purpose: input.purpose,
        operationId: requestedOperationId,
        vault,
        priorLoaded,
        ...evidence,
        ...resumeEvidenceFields(evidence),
        requestedAt: now,
        phaseChangedAt: now,
        lastError: null,
      });
      writeJournal(pair.journal, () => insertActive(pair.journal, active));
    } else {
      if (input.mode !== "recover") {
        throw new Error(`Home lifecycle is suspended by ${existing.purpose}:${existing.operationId}`);
      }
      validateRecoveryOwner(existing, input);
      let recoveredActive = existing;
      if (input.policy === "authorized-upgrade-continuation" && existing.phase !== "resuming") {
        const authorization = await input.authorizeContinuation!(existing);
        validateResumeAuthorization(existing, authorization);
        const evidence = await captureEvidence(vault, service.launchAgentsDir, deps);
        if (!authorizationMatches(authorization, evidence)) {
          throw new Error("current Home evidence does not match the externally authorized upgrade target");
        }
        if (!recoveryEvidenceMatches(existing, evidence)) {
          recoveredActive = authorizeResumeEvidence(pair.journal, existing, evidence);
        }
      } else {
        const evidence = await captureEvidence(vault, service.launchAgentsDir, deps);
        if (!recoveryEvidenceMatches(existing, evidence)) {
          throw new Error("Home installation or plist evidence changed since suspension");
        }
      }
      if (recoveredActive.phase !== "resuming") {
        const currentlyLoaded = await probeLaunchAgentLoadedStrict({ launchctl: service.launchctl, target });
        await assertNoCompetingHost(vault, currentlyLoaded, service, deps);
      }
      active = recoveredActive;
      recovered = true;
    }
    pair.ownership.run("COMMIT");
    await deps.checkpoint?.("intent-committed");

    // Tx2 is live serialization. Durable journal commits do not release it.
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    active = requireSameActive(pair.journal, vault, active);
    const execution = await runOwnedSuspension({
      pair,
      active,
      recovered,
      label,
      target,
      service,
      deps,
      operation,
      recoveryPolicy: input.mode === "recover" ? input.policy : null,
    });
    pair.ownership.run("COMMIT");

    if (execution.operationError !== null) {
      if (execution.result.kind === "ready" || execution.result.kind === "not-required") {
        throw execution.operationError;
      }
      throw new AggregateError(
        [execution.operationError, new Error(resultFailure(execution.result))],
        "suspended operation failed and Dome Home could not resume",
      );
    }
    return execution.result;
  } catch (error) {
    rollback(pair.ownership);
    throw error;
  } finally {
    closePair(pair);
  }
}

async function runOwnedSuspension<T>(input: {
  readonly pair: CoordinatorPair;
  readonly active: HomeLifecycleSuspension;
  readonly recovered: boolean;
  readonly label: string;
  readonly target: string;
  readonly service: ReturnType<typeof resolveServiceDeps>;
  readonly deps: HomeLifecycleSuspensionDeps;
  readonly operation: (context: HomeSuspensionOperationContext) => Promise<T>;
  readonly recoveryPolicy: HomeSuspensionRecoveryPolicy | null;
}): Promise<{ readonly result: SupervisedHomeSuspensionResult<T>; readonly operationError: unknown | null }> {
  let active = input.active;
  let operationRan = false;
  let value: T | undefined;
  let operationError: unknown | null = null;

  if (active.phase !== "resuming") {
    if (await probeLaunchAgentLoadedStrict({ launchctl: input.service.launchctl, target: input.target })) {
      const bootout = await input.service.launchctl(["bootout", input.target]);
      if (bootout.exitCode !== 0) {
        const error = `launchctl bootout failed: ${launchctlDetail(bootout)}`;
        persistError(input.pair.journal, active.operationId, error);
        return { result: failed(active, input.recovered, false, error), operationError };
      }
    }
    const drained = await waitForLaunchAgentDrainStrict({
      launchctl: input.service.launchctl,
      target: input.target,
      timeoutMs: input.service.drainTimeoutMs,
    });
    if (!drained) {
      const error = "Dome Home did not stop before the launchd drain timeout";
      persistError(input.pair.journal, active.operationId, error);
      return { result: failed(active, input.recovered, false, error), operationError };
    }
    if (active.phase === "suspending") {
      active = transition(input.pair.journal, active, "suspended", null, input.deps);
    }
    const evidence = await captureEvidence(active.vault, input.service.launchAgentsDir, input.deps);
    if (!recoveryEvidenceMatches(active, evidence)) {
      const error = "Home installation or plist evidence changed while suspended";
      persistError(input.pair.journal, active.operationId, error);
      return { result: failed(active, input.recovered, false, error), operationError };
    }
    if (input.recoveryPolicy !== "resume-only") {
      operationRan = true;
      const context: HomeSuspensionOperationContext = Object.freeze({
        operationId: active.operationId,
        purpose: active.purpose,
        authorizeCurrentHomeForResume: async () => {
          if (active.purpose !== "upgrade") throw new Error("only an upgrade may authorize changed Home resume evidence");
          const authorized = await captureEvidence(active.vault, input.service.launchAgentsDir, input.deps);
          active = authorizeResumeEvidence(input.pair.journal, active, authorized);
        },
      });
      try { value = await input.operation(context); }
      catch (error) { operationError = error; }
      await input.deps.checkpoint?.("callback-returned");
    }
  }

  const admission = await acquireOperationalWriterLease({
    vaultPath: active.vault,
    command: "home-lifecycle-resume",
  });
  if (!admission.ok) {
    if (active.phase === "resuming") {
      active = transition(input.pair.journal, active, "suspended", "operational write admission closed before resume", input.deps);
    }
    const base = resultBase(active, input.recovered, operationRan, value);
    const result: SupervisedHomeSuspensionResult<T> = admission.error.kind === "write-admission-closed"
      ? Object.freeze({ ...base, kind: "deferred" as const, reason: "write-barrier-closed" as const, transactionId: admission.error.transactionId })
      : Object.freeze({ ...base, kind: "failed" as const, error: `cannot acquire resume admission: ${admission.error.cause}` });
    persistError(input.pair.journal, active.operationId, resultFailure(result));
    return { result, operationError };
  }

  try {
    if (active.phase !== "resuming") {
      const evidence = await captureEvidence(active.vault, input.service.launchAgentsDir, input.deps);
      if (!sameResumeEvidence(active, evidence)) {
        const error = "Home selector or plist is not the authorized resume target";
        persistError(input.pair.journal, active.operationId, error);
        return {
          result: Object.freeze({
            ...resultBase(active, input.recovered, operationRan, value),
            kind: "failed" as const,
            error,
          }),
          operationError,
        };
      }
      try {
        active = transition(input.pair.journal, active, "resuming", operationError === null ? null : message(operationError), input.deps);
      } catch (transitionError) {
        if (operationError !== null) {
          throw new AggregateError(
            [operationError, transitionError],
            "suspended operation failed and its resuming phase could not be persisted",
          );
        }
        throw transitionError;
      }
    }

    let result: SupervisedHomeSuspensionResult<T>;
    try {
      result = await resumeOwned<T>({
        active,
        recovered: input.recovered,
        operationRan,
        value,
        service: input.service,
        label: input.label,
        target: input.target,
        journal: input.pair.journal,
        deps: input.deps,
      });
    } catch (resumeError) {
      const detail = `Dome Home resume failed: ${message(resumeError)}`;
      persistError(input.pair.journal, active.operationId, detail);
      result = Object.freeze({
        ...resultBase(active, input.recovered, operationRan, value),
        kind: "failed" as const,
        error: detail,
      });
    }
    return { result, operationError };
  } finally { admission.lease.close(); }
}

async function resumeOwned<T>(input: {
  readonly active: HomeLifecycleSuspension;
  readonly recovered: boolean;
  readonly operationRan: boolean;
  readonly value: T | undefined;
  readonly service: ReturnType<typeof resolveServiceDeps>;
  readonly label: string;
  readonly target: string;
  readonly journal: Database;
  readonly deps: HomeLifecycleSuspensionDeps;
}): Promise<SupervisedHomeSuspensionResult<T>> {
  const base = resultBase(input.active, input.recovered, input.operationRan, input.value);
  if (!input.active.priorLoaded) {
    clearActive(input.journal, input.active.operationId);
    return Object.freeze({ ...base, kind: "not-required" as const });
  }

  let evidence: Evidence;
  try { evidence = await captureEvidence(input.active.vault, input.service.launchAgentsDir, input.deps); }
  catch (error) {
    const detail = message(error);
    persistError(input.journal, input.active.operationId, detail);
    return Object.freeze({ ...base, kind: "failed" as const, error: detail });
  }
  if (!sameResumeEvidence(input.active, evidence)) {
    const error = "Home installation or plist evidence changed while suspended";
    persistError(input.journal, input.active.operationId, error);
    return Object.freeze({ ...base, kind: "failed" as const, error });
  }

  if (!await probeLaunchAgentLoadedStrict({ launchctl: input.service.launchctl, target: input.target })) {
    const activation = await activateLaunchAgent({
      launchctl: input.service.launchctl,
      uid: input.service.uid!,
      label: input.label,
      plistPath: input.active.resumePlistPath,
    });
    if (activation !== null) {
      persistError(input.journal, input.active.operationId, activation);
      return Object.freeze({ ...base, kind: "failed" as const, error: activation });
    }
  }
  if (!await waitForReadiness(input.deps)) {
    const error = "Dome Home restarted but did not become pairing-ready";
    persistError(input.journal, input.active.operationId, error);
    return Object.freeze({ ...base, kind: "failed" as const, error });
  }
  await input.deps.checkpoint?.("readiness-proven");
  clearActive(input.journal, input.active.operationId);
  return Object.freeze({ ...base, kind: "ready" as const });
}

function resultBase<T>(active: HomeLifecycleSuspension, recovered: boolean, operationRan: boolean, value: T | undefined): SuspensionResultBase<T> {
  return Object.freeze({
    operationId: active.operationId,
    recovered,
    operationRan,
    ...(operationRan ? { value: value as T } : {}),
  });
}

function failed<T>(active: HomeLifecycleSuspension, recovered: boolean, operationRan: boolean, error: string): SupervisedHomeSuspensionResult<T> {
  return Object.freeze({ ...resultBase<T>(active, recovered, operationRan, undefined), kind: "failed" as const, error });
}

function resultFailure<T>(result: SupervisedHomeSuspensionResult<T>): string {
  return result.kind === "deferred"
    ? `operational write admission is closed by ${result.transactionId}`
    : result.kind === "failed" ? result.error : "Dome Home resume failed";
}

type CoordinatorPair = { readonly ownership: Database; readonly journal: Database };
type CoordinatorPaths = {
  readonly locks: string;
  readonly root: string;
  readonly layout: string;
  readonly journal: string;
  readonly ownership: string;
  readonly establishmentRoot: string;
  readonly establishmentMarker: string;
};
type LayoutMarker = { readonly schema: typeof LAYOUT_SCHEMA; readonly state: "ready"; readonly layoutId: string };
type EstablishmentMarker = { readonly schema: typeof ESTABLISHMENT_SCHEMA; readonly layoutId: string };

async function openCoordinatorPair(vault: string, beforeEstablishmentJournalRead?: () => Promise<void>): Promise<CoordinatorPair> {
  const paths = coordinatorPaths(vault);
  await ensureCoordinatorLayout(vault, beforeEstablishmentJournalRead);
  const layout = readLayoutMarker(paths.layout);
  const establishment = readEstablishmentMarker(paths);
  if (layout.layoutId !== establishment.layoutId) {
    throw new Error("Home lifecycle coordinator establishment layout id does not match its root");
  }
  const ownershipPresent = pathPresent(paths.ownership);
  const journalPresent = pathPresent(paths.journal);
  if (!ownershipPresent || !journalPresent) {
    throw new Error("Home lifecycle coordinator database is missing from a ready layout");
  }
  const ownership = openEstablishedWritable(paths.ownership, OWNERSHIP_DDL, validateOwnershipRow);
  try {
    const layout = readOwnershipLayout(ownership);
    if (layout !== "ready") {
      throw new Error("Home lifecycle layout marker and ownership state disagree");
    }
    const journal = openEstablishedWritable(paths.journal, JOURNAL_DDL, () => {});
    validateOwnershipRow(ownership);
    return Object.freeze({ ownership, journal });
  } catch (error) {
    ownership.close();
    throw error;
  }
}

function closePair(pair: CoordinatorPair): void {
  pair.journal.close();
  pair.ownership.close();
}

function coordinatorPaths(vault: string): CoordinatorPaths {
  const locks = join(vault, ".dome", "state", "locks");
  const root = join(locks, STORAGE_NAME);
  const establishmentRoot = join(locks, ESTABLISHMENT_NAME);
  return Object.freeze({
    locks,
    root,
    layout: join(root, LAYOUT_NAME),
    journal: join(root, JOURNAL_NAME),
    ownership: join(root, OWNERSHIP_NAME),
    establishmentRoot,
    establishmentMarker: join(establishmentRoot, LAYOUT_NAME),
  });
}

async function ensureCoordinatorLayout(vault: string, beforeEstablishmentJournalRead?: () => Promise<void>): Promise<void> {
  const dome = join(vault, ".dome");
  const state = join(dome, "state");
  const locks = join(state, "locks");
  ensureDirectDirectory(dome, false);
  ensureDirectDirectory(state, false);
  ensureDirectDirectory(locks, true);
  const paths = coordinatorPaths(vault);
  const rootPresent = pathPresent(paths.root);
  const establishmentPresent = pathPresent(paths.establishmentRoot);
  if (!rootPresent && establishmentPresent) {
    throw new Error("established Home lifecycle coordinator root is missing");
  }
  if (!rootPresent) {
    await publishCompleteStorageRoot(paths.root, locks, randomUUID().replaceAll("-", ""));
  }
  validateDirectPrivateDirectory(paths.root);
  if (!pathPresent(paths.layout)) {
    throw new Error("Home lifecycle suspension layout marker is missing from an established directory");
  }
  const layout = readLayoutMarker(paths.layout);
  if (!pathPresent(paths.establishmentRoot)) {
    const rootState = await validateUnestablishedRoot(paths, vault, beforeEstablishmentJournalRead);
    if (rootState === "empty") {
      await publishEstablishmentRoot(paths.establishmentRoot, locks, layout.layoutId);
    } else if (!pathPresent(paths.establishmentRoot)) {
      throw new Error("active Home lifecycle coordinator is missing immutable establishment evidence");
    }
  }
  const establishment = readEstablishmentMarker(paths);
  if (establishment.layoutId !== layout.layoutId) {
    throw new Error("Home lifecycle coordinator establishment layout id does not match its root");
  }
}

async function publishCompleteStorageRoot(root: string, parent: string, layoutId: string): Promise<void> {
  if (!LAYOUT_ID.test(layoutId)) throw new Error("Home lifecycle coordinator layout id is invalid");
  const staging = join(parent, `.${STORAGE_NAME}.init-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    publishLayoutMarker(join(staging, LAYOUT_NAME), layoutId);
    const ownership = await openOrInitialize(join(staging, OWNERSHIP_NAME), OWNERSHIP_DDL, (db) => {
      db.query(`INSERT INTO ${OWNERSHIP_TABLE} (singleton, schema, layout_state) VALUES (1, ?, 'ready')`).run(OWNERSHIP_SCHEMA);
    }, validateOwnershipRow);
    ownership.close();
    const journal = await openOrInitialize(join(staging, JOURNAL_NAME), JOURNAL_DDL, () => {}, () => {});
    journal.close();
    fsyncPath(staging);
    try {
      renameSync(staging, root);
      fsyncPath(parent);
    } catch (error) {
      if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function publishEstablishmentRoot(root: string, parent: string, layoutId: string): Promise<void> {
  const staging = join(parent, `.${ESTABLISHMENT_NAME}.init-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    publishEstablishmentMarker(join(staging, LAYOUT_NAME), layoutId);
    fsyncPath(staging);
    try {
      renameSync(staging, root);
      fsyncPath(parent);
    } catch (error) {
      if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error;
      const existing = readEstablishmentMarker({ establishmentRoot: root, establishmentMarker: join(root, LAYOUT_NAME) });
      if (existing.layoutId !== layoutId) {
        throw new Error("concurrent Home lifecycle establishment selected a different layout id");
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function validateUnestablishedRoot(
  paths: CoordinatorPaths,
  vault: string,
  beforeJournalRead?: () => Promise<void>,
): Promise<"empty" | "active"> {
  if (!pathPresent(paths.ownership) || !pathPresent(paths.journal)) {
    throw new Error("Home lifecycle coordinator database is missing before establishment");
  }
  const ownership = await openEstablishedForInspection(paths.ownership, OWNERSHIP_DDL, validateOwnershipRow);
  try {
    const journal = await openEstablishedForInspection(paths.journal, JOURNAL_DDL, () => {});
    try {
      await beforeJournalRead?.();
      return readActive(journal, vault) === null ? "empty" : "active";
    } finally { journal.close(); }
  } finally { ownership.close(); }
}

function ensureDirectDirectory(path: string, privateDirectory: boolean): boolean {
  let created = false;
  try { mkdirSync(path, { mode: privateDirectory ? 0o700 : 0o755 }); created = true; }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new Error(`Home lifecycle suspension path is not a direct directory: ${path}`);
  }
  if (privateDirectory && (info.mode & 0o077) !== 0) {
    if (!created) throw new Error(`Home lifecycle suspension directory is not private: ${path}`);
    chmodSync(path, 0o700);
  }
  if (created) {
    fsyncPath(path);
    fsyncPath(dirname(path));
  }
  return created;
}

function validateDirectPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path) || (info.mode & 0o077) !== 0) {
    throw new Error(`Home lifecycle suspension directory is not direct and private: ${path}`);
  }
}

function readLayoutMarker(path: string): LayoutMarker {
  validateExistingCoordinatorFile(path, "layout marker");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Home lifecycle suspension layout marker is invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["layoutId", "schema", "state"]) ||
    (value as { schema?: unknown }).schema !== LAYOUT_SCHEMA ||
    (value as { state?: unknown }).state !== "ready" ||
    typeof (value as { layoutId?: unknown }).layoutId !== "string" ||
    !LAYOUT_ID.test((value as { layoutId: string }).layoutId)) {
    throw new Error("Home lifecycle suspension layout marker has unknown or invalid fields");
  }
  return Object.freeze(value as LayoutMarker);
}

function publishLayoutMarker(path: string, layoutId: string): void {
  publishMarker(path, { schema: LAYOUT_SCHEMA, state: "ready", layoutId });
}

function readEstablishmentMarker(
  paths: Pick<CoordinatorPaths, "establishmentRoot" | "establishmentMarker">,
): EstablishmentMarker {
  validateDirectPrivateDirectory(paths.establishmentRoot);
  validateExistingCoordinatorFile(paths.establishmentMarker, "establishment marker");
  let value: unknown;
  try { value = JSON.parse(readFileSync(paths.establishmentMarker, "utf8")); }
  catch { throw new Error("Home lifecycle establishment marker is invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["layoutId", "schema"]) ||
    (value as { schema?: unknown }).schema !== ESTABLISHMENT_SCHEMA ||
    typeof (value as { layoutId?: unknown }).layoutId !== "string" ||
    !LAYOUT_ID.test((value as { layoutId: string }).layoutId)) {
    throw new Error("Home lifecycle establishment marker has unknown or invalid fields");
  }
  return Object.freeze(value as EstablishmentMarker);
}

function publishEstablishmentMarker(path: string, layoutId: string): void {
  publishMarker(path, { schema: ESTABLISHMENT_SCHEMA, layoutId });
}

function publishMarker(path: string, value: Readonly<Record<string, string>>): void {
  const bytes = `${JSON.stringify(value)}\n`;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
  const fd = openSync(path, flags, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncPath(dirname(path));
}

async function openOrInitialize(
  path: string,
  ddl: string,
  seed: (db: Database) => void,
  validateRows: (db: Database) => void,
): Promise<Database> {
  const started = Date.now();
  for (;;) {
    try { return openOrInitializeOnce(path, ddl, seed, validateRows); }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= OWNERSHIP_WAIT_MS) throw error;
      await Bun.sleep(10);
    }
  }
}

function openOrInitializeOnce(path: string, ddl: string, seed: (db: Database) => void, validateRows: (db: Database) => void): Database {
  ensureCoordinatorFile(path);
  const before = lstatSync(path);
  const initializationCandidate = before.size === 0;
  const db = new Database(path);
  try {
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Home lifecycle coordinator changed while opening");
    configureConnection(db, initializationCandidate);
    let initialized = false;
    if (readSchema(db).length === 0) {
      db.run("BEGIN EXCLUSIVE");
      try {
        if (readSchema(db).length === 0) {
          db.run(ddl);
          seed(db);
          initialized = true;
        }
        db.run("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
    }
    validateDatabase(db, ddl);
    validateRows(db);
    if (initialized) {
      fsyncPath(path);
      fsyncPath(dirname(path));
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openEstablished(path: string, ddl: string, validateRows: (db: Database) => void): Database {
  validateExistingCoordinatorFile(path, "coordinator");
  const before = lstatSync(path);
  const db = new Database(path, { readonly: true, create: false });
  try {
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("Home lifecycle coordinator changed while opening");
    }
    configureConnection(db, false);
    validateDatabase(db, ddl);
    validateRows(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openEstablishedWritable(path: string, ddl: string, validateRows: (db: Database) => void): Database {
  validateExistingCoordinatorFile(path, "coordinator");
  const before = lstatSync(path);
  const db = new Database(path, { readwrite: true, create: false });
  try {
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("Home lifecycle coordinator changed while opening");
    }
    configureConnection(db, false);
    validateDatabase(db, ddl);
    validateRows(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function openEstablishedForInspection(path: string, ddl: string, validateRows: (db: Database) => void): Promise<Database> {
  const started = Date.now();
  for (;;) {
    try { return openEstablished(path, ddl, validateRows); }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= 1_000) throw error;
      await Bun.sleep(10);
    }
  }
}

function configureConnection(db: Database, initializing: boolean): void {
  db.run(`PRAGMA busy_timeout = ${BUSY_SLICE_MS}`);
  const journal = initializing
    ? db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()
    : db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  if (journal?.journal_mode.toLowerCase() !== "delete") {
    throw new Error("Home lifecycle coordinator must use DELETE journal mode");
  }
  const locking = db.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get();
  if (locking?.locking_mode.toLowerCase() !== "normal") {
    throw new Error("Home lifecycle coordinator must use NORMAL locking mode");
  }
  db.run("PRAGMA synchronous = FULL");
  if (db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous !== 2) {
    throw new Error("Home lifecycle coordinator must use FULL synchronous mode");
  }
}

function validateDatabase(db: Database, ddl: string): void {
  const schema = readSchema(db);
  const row = schema[0];
  if (schema.length !== 1 || row === undefined || row.type !== "table" || row.sql === null || compactSql(row.sql) !== compactSql(ddl)) {
    throw new Error("Home lifecycle coordinator has an unknown schema layout");
  }
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Home lifecycle coordinator failed integrity_check");
  }
}

function readSchema(db: Database): ReadonlyArray<{ readonly type: string; readonly name: string; readonly sql: string | null }> {
  return db.query<{ type: string; name: string; sql: string | null }, []>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
}

function validateOwnershipRow(db: Database): void { readOwnershipLayout(db); }

function readOwnershipLayout(db: Database): "ready" {
  const rows = db.query<{ singleton: number; schema: string; layout_state: string }, []>(
    `SELECT singleton, schema, layout_state FROM ${OWNERSHIP_TABLE}`,
  ).all();
  const row = rows[0];
  if (rows.length !== 1 || row?.singleton !== 1 || row.schema !== OWNERSHIP_SCHEMA || row.layout_state !== "ready") {
    throw new Error("Home lifecycle ownership singleton is invalid");
  }
  return row.layout_state;
}

function readActive(db: Database, vault: string): HomeLifecycleSuspension | null {
  const rows = db.query<JournalRow, []>(`SELECT * FROM ${JOURNAL_TABLE}`).all();
  if (rows.length === 0) return null;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.singleton !== 1 ||
    row.schema !== HOME_LIFECYCLE_SUSPENSION_SCHEMA ||
    !phase(row.phase) || (row.purpose !== "backup" && row.purpose !== "upgrade") ||
    !OPERATION_ID.test(row.operation_id) || row.vault !== vault ||
    (row.prior_loaded !== 0 && row.prior_loaded !== 1) ||
    !absoluteDirectEvidencePath(row.installation_path) || !absoluteDirectEvidencePath(row.plist_path) ||
    !SHA256.test(row.installation_sha256) || !SHA256.test(row.artifact_id) || !SHA256.test(row.plist_sha256) ||
    !absoluteDirectEvidencePath(row.resume_installation_path) || !absoluteDirectEvidencePath(row.resume_plist_path) ||
    !SHA256.test(row.resume_installation_sha256) || !SHA256.test(row.resume_artifact_id) || !SHA256.test(row.resume_plist_sha256) ||
    row.artifact_version.length === 0 || row.artifact_version.length > 1024 ||
    row.resume_artifact_version.length === 0 || row.resume_artifact_version.length > 1024 ||
    !isExactTimestamp(row.requested_at) || !isExactTimestamp(row.phase_changed_at) ||
    (row.last_error !== null && (row.last_error.length === 0 || row.last_error.length > 4096))) {
    throw new Error("Home lifecycle suspension active row is invalid");
  }
  return Object.freeze({
    schema: HOME_LIFECYCLE_SUSPENSION_SCHEMA,
    phase: row.phase,
    purpose: row.purpose,
    operationId: row.operation_id,
    vault: row.vault,
    priorLoaded: row.prior_loaded === 1,
    installationPath: row.installation_path,
    installationSha256: row.installation_sha256,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    plistPath: row.plist_path,
    plistSha256: row.plist_sha256,
    resumeInstallationPath: row.resume_installation_path,
    resumeInstallationSha256: row.resume_installation_sha256,
    resumeArtifactId: row.resume_artifact_id,
    resumeArtifactVersion: row.resume_artifact_version,
    resumePlistPath: row.resume_plist_path,
    resumePlistSha256: row.resume_plist_sha256,
    requestedAt: row.requested_at,
    phaseChangedAt: row.phase_changed_at,
    lastError: row.last_error,
  });
}

function insertActive(db: Database, row: HomeLifecycleSuspension): void {
  db.query(`INSERT INTO ${JOURNAL_TABLE} (
    singleton, schema, phase, purpose, operation_id, vault, prior_loaded,
    installation_path, installation_sha256, artifact_id, artifact_version,
    plist_path, plist_sha256, resume_installation_path, resume_installation_sha256,
    resume_artifact_id, resume_artifact_version, resume_plist_path, resume_plist_sha256,
    requested_at, phase_changed_at, last_error
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.schema, row.phase, row.purpose, row.operationId, row.vault,
    row.priorLoaded ? 1 : 0, row.installationPath, row.installationSha256,
    row.artifactId, row.artifactVersion, row.plistPath, row.plistSha256,
    row.resumeInstallationPath, row.resumeInstallationSha256, row.resumeArtifactId,
    row.resumeArtifactVersion, row.resumePlistPath, row.resumePlistSha256,
    row.requestedAt, row.phaseChangedAt, row.lastError,
  );
}

function transition(db: Database, row: HomeLifecycleSuspension, next: HomeSuspensionPhase, error: string | null, deps: HomeLifecycleSuspensionDeps): HomeLifecycleSuspension {
  const changedAt = exactTimestamp((deps.now ?? (() => new Date()))());
  writeJournal(db, () => {
    const changed = db.query(
      `UPDATE ${JOURNAL_TABLE} SET phase = ?, phase_changed_at = ?, last_error = ?
       WHERE singleton = 1 AND operation_id = ? AND phase = ?`,
    ).run(next, changedAt, boundedError(error), row.operationId, row.phase).changes;
    if (changed !== 1) throw new Error("Home lifecycle suspension phase changed concurrently");
  });
  return Object.freeze({ ...row, phase: next, phaseChangedAt: changedAt, lastError: boundedError(error) });
}

function persistError(db: Database, operationId: string, error: string): void {
  writeJournal(db, () => {
    if (db.query(`UPDATE ${JOURNAL_TABLE} SET last_error = ? WHERE singleton = 1 AND operation_id = ?`)
      .run(boundedError(error), operationId).changes !== 1) {
      throw new Error("Home lifecycle suspension ownership changed while recording failure");
    }
  });
}

function clearActive(db: Database, operationId: string): void {
  writeJournal(db, () => {
    if (db.query(`DELETE FROM ${JOURNAL_TABLE} WHERE singleton = 1 AND operation_id = ?`).run(operationId).changes !== 1) {
      throw new Error("Home lifecycle suspension ownership changed while clearing readiness");
    }
  });
}

function writeJournal(db: Database, operation: () => void): void {
  db.run("BEGIN IMMEDIATE");
  try {
    operation();
    db.run("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function requireSameActive(db: Database, vault: string, expected: HomeLifecycleSuspension): HomeLifecycleSuspension {
  const current = readActive(db, vault);
  if (current === null || current.operationId !== expected.operationId || current.purpose !== expected.purpose ||
    !sameEvidence(current, expected) || !sameResumeEvidence(current, resumeEvidence(expected))) {
    throw new Error("Home lifecycle suspension ownership changed before Tx2");
  }
  return current;
}

function validateRecoveryInvocation(input: HomeSuspensionInvocation): void {
  if (input.mode !== "recover") return;
  if (input.policy === "authorized-upgrade-continuation") {
    if (input.purpose !== "upgrade" || input.authorizeContinuation === undefined) {
      throw new Error("authorized upgrade continuation requires upgrade purpose and an external authorizer");
    }
  } else if (input.authorizeContinuation !== undefined) {
    throw new Error("only authorized upgrade continuation accepts an external authorizer");
  }
}

function validateRecoveryOwner(active: HomeLifecycleSuspension, input: Extract<HomeSuspensionInvocation, { mode: "recover" }>): void {
  if (active.purpose !== input.purpose) throw new Error(`Home lifecycle is suspended by ${active.purpose}:${active.operationId}`);
  if (active.operationId !== input.operationId) {
    throw new Error(`Home lifecycle suspension belongs to operation ${active.operationId}`);
  }
}

function validateResumeAuthorization(active: HomeLifecycleSuspension, authorization: HomeResumeAuthorization): void {
  if (authorization.operationId !== active.operationId || !SHA256.test(authorization.artifactId) ||
    authorization.artifactVersion.length === 0 || authorization.artifactVersion.length > 1024 ||
    !SHA256.test(authorization.installationSha256) || !SHA256.test(authorization.plistSha256)) {
    throw new Error("external upgrade resume authorization is invalid or belongs to another operation");
  }
}

function authorizationMatches(authorization: HomeResumeAuthorization, evidence: Evidence): boolean {
  return authorization.artifactId === evidence.artifactId &&
    authorization.artifactVersion === evidence.artifactVersion &&
    authorization.installationSha256 === evidence.installationSha256 &&
    authorization.plistSha256 === evidence.plistSha256;
}

async function captureEvidence(vault: string, launchAgentsDir: string, deps: HomeInstallationDeps): Promise<Evidence> {
  const installation = await readHomeInstallation(vault, deps);
  if (installation === null) throw new Error("Dome Home must be installed before lifecycle suspension");
  const installationPath = homeInstallationPaths(vault, deps).record;
  const plistPath = join(launchAgentsDir, `com.dome.home.${vaultServiceSlug(vault)}.plist`);
  const installationBytes = await readStrictEvidence(installationPath, "installation");
  const plistBytes = await readStrictEvidence(plistPath, "plist");
  return Object.freeze({
    installationPath,
    installationSha256: hash(installationBytes),
    artifactId: installation.artifact.id,
    artifactVersion: installation.artifact.version,
    plistPath,
    plistSha256: hash(plistBytes),
  });
}

async function captureStartupEvidence(vault: string, deps: HomeStartupAdmissionDeps): Promise<Evidence> {
  const launchAgentsDir = resolveServiceDeps(deps).launchAgentsDir;
  return captureEvidence(vault, launchAgentsDir, deps);
}

async function verifyStartupProvenance(
  vault: string,
  launchArtifact: { readonly id: string; readonly version: string },
  deps: HomeStartupAdmissionDeps,
): Promise<void> {
  const installation = await readHomeInstallation(vault, deps);
  if (installation === null) throw new Error("Dome Home must be installed for exact resume startup");
  const evidence = {
    artifactId: installation.artifact.id,
    artifactVersion: installation.artifact.version,
  };
  if (evidence.artifactId !== launchArtifact.id || evidence.artifactVersion !== launchArtifact.version) {
    throw new Error("installed Home artifact does not match the normal launch artifact");
  }
  const paths = homeInstallationPaths(vault, deps);
  const release = releaseRoot(paths, evidence.artifactId);
  const manifest = await (deps.verifyArtifact ?? verifyHomeArtifact)(release);
  if (manifest.artifact.id !== evidence.artifactId || manifest.product.version !== evidence.artifactVersion) {
    throw new Error("verified managed release does not match the authorized Home resume artifact");
  }
  await assertExactInvokingFile(
    deps.invokingRuntimePath ?? process.execPath,
    join(release, "runtime", "bun"),
    "runtime",
  );
  await assertExactInvokingFile(
    deps.invokingEntrypointPath ?? process.argv[1] ?? "",
    join(release, "app", "bin", "dome"),
    "entrypoint",
  );
}

async function assertExactInvokingFile(actualInput: string, expectedInput: string, label: string): Promise<void> {
  if (actualInput.length === 0) throw new Error(`invoking Home ${label} path is unavailable`);
  const actual = resolve(actualInput);
  const expected = resolve(expectedInput);
  const [actualInfo, expectedInfo, actualReal, expectedReal] = await Promise.all([
    lstat(actual),
    lstat(expected),
    realpath(actual),
    realpath(expected),
  ]);
  if (!actualInfo.isFile() || actualInfo.isSymbolicLink() || actualInfo.nlink !== 1 ||
    !expectedInfo.isFile() || expectedInfo.isSymbolicLink() || expectedInfo.nlink !== 1 ||
    actual !== actualReal || expected !== expectedReal || actualReal !== expectedReal) {
    throw new Error(`invoking Home ${label} is not the exact direct managed-release file`);
  }
}

async function readStrictEvidence(path: string, label: string): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024 || realpathSync(path) !== resolve(path)) {
    throw new Error(`Dome Home ${label} evidence is not a direct bounded regular file`);
  }
  return readFile(path);
}

function sameEvidence(left: Evidence, right: Evidence): boolean {
  return left.installationPath === right.installationPath &&
    left.installationSha256 === right.installationSha256 &&
    left.artifactId === right.artifactId &&
    left.artifactVersion === right.artifactVersion &&
    left.plistPath === right.plistPath &&
    left.plistSha256 === right.plistSha256;
}

function sameActive(left: HomeLifecycleSuspension, right: HomeLifecycleSuspension): boolean {
  return left.schema === right.schema && left.phase === right.phase &&
    left.purpose === right.purpose && left.operationId === right.operationId &&
    left.vault === right.vault && left.priorLoaded === right.priorLoaded &&
    left.installationPath === right.installationPath && left.installationSha256 === right.installationSha256 &&
    left.artifactId === right.artifactId && left.artifactVersion === right.artifactVersion &&
    left.plistPath === right.plistPath && left.plistSha256 === right.plistSha256 &&
    left.resumeInstallationPath === right.resumeInstallationPath &&
    left.resumeInstallationSha256 === right.resumeInstallationSha256 &&
    left.resumeArtifactId === right.resumeArtifactId &&
    left.resumeArtifactVersion === right.resumeArtifactVersion &&
    left.resumePlistPath === right.resumePlistPath && left.resumePlistSha256 === right.resumePlistSha256 &&
    left.requestedAt === right.requestedAt && left.phaseChangedAt === right.phaseChangedAt &&
    left.lastError === right.lastError;
}

function resumeEvidenceFields(evidence: Evidence): Pick<HomeLifecycleSuspension,
  "resumeInstallationPath" | "resumeInstallationSha256" | "resumeArtifactId" |
  "resumeArtifactVersion" | "resumePlistPath" | "resumePlistSha256"> {
  return Object.freeze({
    resumeInstallationPath: evidence.installationPath,
    resumeInstallationSha256: evidence.installationSha256,
    resumeArtifactId: evidence.artifactId,
    resumeArtifactVersion: evidence.artifactVersion,
    resumePlistPath: evidence.plistPath,
    resumePlistSha256: evidence.plistSha256,
  });
}

function resumeEvidence(row: HomeLifecycleSuspension): Evidence {
  return Object.freeze({
    installationPath: row.resumeInstallationPath,
    installationSha256: row.resumeInstallationSha256,
    artifactId: row.resumeArtifactId,
    artifactVersion: row.resumeArtifactVersion,
    plistPath: row.resumePlistPath,
    plistSha256: row.resumePlistSha256,
  });
}

function sameResumeEvidence(row: HomeLifecycleSuspension, evidence: Evidence): boolean {
  return sameEvidence(resumeEvidence(row), evidence);
}

function recoveryEvidenceMatches(row: HomeLifecycleSuspension, evidence: Evidence): boolean {
  return sameEvidence(row, evidence) || sameResumeEvidence(row, evidence);
}

function authorizeResumeEvidence(db: Database, row: HomeLifecycleSuspension, evidence: Evidence): HomeLifecycleSuspension {
  if (row.phase !== "suspended") throw new Error("resume evidence can be authorized only while suspended");
  writeJournal(db, () => {
    const changed = db.query(
      `UPDATE ${JOURNAL_TABLE}
       SET resume_installation_path = ?, resume_installation_sha256 = ?,
           resume_artifact_id = ?, resume_artifact_version = ?,
           resume_plist_path = ?, resume_plist_sha256 = ?
       WHERE singleton = 1 AND operation_id = ? AND phase = 'suspended'`,
    ).run(
      evidence.installationPath, evidence.installationSha256, evidence.artifactId,
      evidence.artifactVersion, evidence.plistPath, evidence.plistSha256, row.operationId,
    ).changes;
    if (changed !== 1) throw new Error("Home lifecycle suspension changed while authorizing resume evidence");
  });
  return Object.freeze({ ...row, ...resumeEvidenceFields(evidence) });
}

async function assertNoCompetingHost(
  vault: string,
  homeLoaded: boolean,
  service: ReturnType<typeof resolveServiceDeps>,
  deps: HomeLifecycleSuspensionDeps,
): Promise<void> {
  const legacyLabel = serviceLabelForVault(vault);
  const legacyPlist = join(service.launchAgentsDir, `${legacyLabel}.plist`);
  const injectedLegacy = deps.legacyServeRunning === undefined ? null : await deps.legacyServeRunning();
  const heartbeat = injectedLegacy === null ? await readServeHeartbeatStatus({ vaultPath: vault }) : null;
  const legacyLoaded = await probeLaunchAgentLoadedStrict({
    launchctl: service.launchctl,
    target: `gui/${service.uid!}/${legacyLabel}`,
  });
  if (existsSync(legacyPlist) || injectedLegacy === true || heartbeat?.status === "running" || legacyLoaded) {
    throw new Error("legacy dome serve is installed or running; stop it before suspending Dome Home");
  }
  if (!homeLoaded && await probeReadiness(deps)) {
    throw new Error("a foreground Dome Home is pairing-ready outside launchd; stop it before suspension");
  }
}

async function waitForReadiness(deps: HomeLifecycleSuspensionDeps): Promise<boolean> {
  const deadline = Date.now() + (deps.readinessTimeoutMs ?? 10_000);
  do {
    try {
      if (await probeReadiness(deps)) return true;
    } catch { /* retry until bounded timeout */ }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(200);
  } while (true);
}

async function probeReadiness(deps: HomeLifecycleSuspensionDeps): Promise<boolean> {
  return deps.readiness !== undefined
    ? deps.readiness()
    : isHomePairingReadiness(await fetch("http://127.0.0.1:3663/pair/status"));
}


function ensureCoordinatorFile(path: string): void {
  let created = false;
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(), 0o600);
    closeSync(fd);
    created = true;
  } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  if (created) chmodSync(path, 0o600);
  validateExistingCoordinatorFile(path, "coordinator");
  if (created) {
    fsyncPath(path);
    fsyncPath(dirname(path));
  }
}

function validateExistingCoordinatorFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 || realpathSync(path) !== resolve(path)) {
    throw new Error(`Home lifecycle ${label} must be a direct private regular file`);
  }
}

async function beginImmediate(db: Database): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { db.run("BEGIN IMMEDIATE"); return; }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= OWNERSHIP_WAIT_MS) throw error;
      await Bun.sleep(10);
    }
  }
}

function rollback(db: Database): void { try { db.run("ROLLBACK"); } catch {} }
function canonicalVault(path: string): string { return realpathSync(resolve(path)); }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function phase(value: string): value is HomeSuspensionPhase { return value === "suspending" || value === "suspended" || value === "resuming"; }
function absoluteDirectEvidencePath(value: string): boolean { return value.length > 0 && value === resolve(value); }
function exactTimestamp(value: Date): string { const timestamp = value.toISOString(); if (!isExactTimestamp(timestamp)) throw new Error("timestamp is invalid"); return timestamp; }
function isExactTimestamp(value: string): boolean { const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value; }
function compactSql(value: string): string { return value.replace(/\s+/g, " ").trim().replace(/;$/, ""); }
function boundedError(value: string | null): string | null { return value === null ? null : value.slice(0, 4096) || "unknown failure"; }
function launchctlDetail(result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): string { return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function operationalAdmissionMessage(error: OperationalWriterAdmissionError): string {
  return error.kind === "write-admission-closed"
    ? `Dome operational write admission is closed by ${error.transactionId}`
    : `Dome operational writer coordination failed: ${error.cause}`;
}
function startupDenied(
  kind: Extract<HomeStartupAdmission, { ok: false }>["error"]["kind"],
  detail: string,
  operationId?: string,
): HomeStartupAdmission {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind, message: detail, ...(operationId === undefined ? {} : { operationId }) }),
  });
}
function assertOperationId(value: string): void { if (!OPERATION_ID.test(value)) throw new Error("Home suspension operation id is invalid"); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
function pathPresent(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; } }
function isBusy(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "SQLITE_BUSY"; }
function noFollowFlag(): number { return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0; }
function fsyncPath(path: string): void { const fd = openSync(path, constants.O_RDONLY | noFollowFlag()); try { fsyncSync(fd); } finally { closeSync(fd); } }
