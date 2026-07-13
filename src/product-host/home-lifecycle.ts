// product-host/home-lifecycle: supervised macOS Dome Home lifecycle over one
// closed per-vault installation record and immutable managed releases.

import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { findGitRoot } from "../git";
import { readServeHeartbeatStatus } from "../engine/host/compiler-host-heartbeat";
import {
  acquireOperationalWriterLease,
  type OperationalWriterAdmissionError,
  type OperationalWriterLease,
} from "../operational-state/writer-barrier";
import {
  activateLaunchAgent,
  probeLaunchAgentLoadedStrict,
  publishLaunchAgentPlist,
  renderLaunchAgentPlist,
  waitForLaunchAgentDrainStrict,
} from "../platform/launchd";
import {
  resolveServiceDeps,
  serviceLabelForVault,
  vaultServiceSlug,
  type ServiceDeps,
} from "../surface/service-probe";
import { verifyHomeArtifact, type HomeArtifactManifest, type HomeArtifactVerifier } from "./home-artifact";
import {
  createHomeInstallation,
  ensureManagedRelease,
  homeInstallationPaths,
  publishHomeInstallation,
  readHomeInstallation,
  releaseRoot,
  syncDirectory,
  type HomeInstallationDeps,
  type HomeInstallationRecord,
} from "./home-installation";
import { isHomePairingReadiness } from "./home-readiness";
import {
  inspectHomeLifecycleSuspension,
  withHomeLifecycleMutation,
  type HomeLifecycleSuspensionInspection,
  type HomeSuspensionPhase,
  type HomeSuspensionPurpose,
} from "./home-lifecycle-suspension";

export { isHomePairingReadiness } from "./home-readiness";

export const HOME_LIFECYCLE_SCHEMA = "dome.home.lifecycle/v1" as const;
const HOME_HOST = "127.0.0.1";
const HOME_PORT = 3663;

export type HomeLifecycleAction = "install" | "start" | "restart" | "status" | "uninstall";
export type HomeLifecycleStatus =
  | "installed" | "started" | "restarted" | "ready" | "loaded-unreachable"
  | "installed-stopped" | "not-installed" | "uninstalled" | "missing-release"
  | "corrupt-release" | "plist-mismatch" | "orphaned-service" | "invalid-installation" | "error";

export type HomeLifecycleRecovery =
  | { readonly state: "inactive" }
  | {
      readonly state: "active";
      readonly phase: HomeSuspensionPhase;
      readonly purpose: HomeSuspensionPurpose;
      readonly operationId: string;
      readonly lastError: string | null;
    }
  | { readonly state: "unavailable" | "invalid"; readonly error: string };

export type HomeLifecycleResult = {
  readonly schema: typeof HOME_LIFECYCLE_SCHEMA;
  readonly action: HomeLifecycleAction;
  readonly status: HomeLifecycleStatus;
  readonly vault: string;
  readonly label: string;
  readonly plist: string;
  readonly log: string;
  readonly program: string;
  readonly installation: string;
  readonly release: string | null;
  readonly artifactId: string | null;
  readonly productVersion: string | null;
  readonly exitCode: 0 | 1 | 64;
  readonly installed: boolean | null;
  readonly loaded: boolean | null;
  readonly ready: boolean | null;
  readonly replaced?: boolean;
  readonly releasePublished?: boolean;
  readonly legacyServeConflict?: boolean;
  readonly lifecycle?: HomeLifecycleRecovery;
  readonly error?: string;
};

export type HomeLifecycleDeps = ServiceDeps & HomeInstallationDeps & {
  /** Invoking self-contained artifact root; tests may inject a strict verifier. */
  readonly artifactRoot?: string | undefined;
  readonly verifyArtifact?: HomeArtifactVerifier | undefined;
  readonly readiness?: (() => Promise<boolean>) | undefined;
  readonly readinessTimeoutMs?: number;
  readonly legacyServeRunning?: (() => Promise<boolean>) | undefined;
  readonly publishPlist?: ((path: string, contents: string) => Promise<void>) | undefined;
  readonly unlinkPlist?: ((path: string) => Promise<void>) | undefined;
  readonly syncPlistParent?: ((path: string) => Promise<void>) | undefined;
  /** Test-only ordering seam after lifecycle ownership and before SHARED admission. */
  readonly beforeOperationalAdmission?: (() => Promise<void>) | undefined;
  /** Test-only failure seam after mutation/activation and before lifecycle commit. */
  readonly afterOwnedMutation?: (() => Promise<void>) | undefined;
  /** Test-only lease-close seam; production calls the lease directly. */
  readonly closeOperationalLease?: ((lease: OperationalWriterLease) => void) | undefined;
};

type Base = Pick<HomeLifecycleResult,
  "schema" | "action" | "vault" | "label" | "plist" | "log" | "program" |
  "installation" | "release" | "artifactId" | "productVersion">;

type HomeContext = {
  readonly vault: string;
  readonly service: ReturnType<typeof resolveServiceDeps>;
  readonly paths: ReturnType<typeof homeInstallationPaths>;
  readonly label: string;
  readonly plist: string;
  readonly log: string;
  readonly target: string;
  readonly neutral: Base;
};

type OwnedMutationResult =
  | { readonly kind: "complete"; readonly result: HomeLifecycleResult }
  | {
      readonly kind: "await-readiness";
      readonly base: Base;
      readonly successStatus: "installed" | "started" | "restarted";
      readonly failure: string;
      readonly replaced?: boolean;
      readonly releasePublished?: boolean;
    };

export function homeServiceLabelForVault(vaultPath: string): string {
  return `com.dome.home.${vaultServiceSlug(vaultPath)}`;
}

export async function manageHome(input: {
  readonly action: HomeLifecycleAction;
  readonly vaultPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}, deps: HomeLifecycleDeps = {}): Promise<HomeLifecycleResult> {
  const requestedVault = resolve(input.vaultPath);
  let service: ReturnType<typeof resolveServiceDeps>;
  try { service = resolveServiceDeps(deps); }
  catch (error) {
    return preflightFailure(input.action, requestedVault, deps, null, message(error));
  }
  let vault: string;
  try { vault = await realpath(requestedVault); }
  catch {
    return preflightFailure(input.action, requestedVault, deps, service, "vault path does not exist or cannot be canonicalized");
  }
  const context = homeContext(input.action, vault, service, deps);
  if (service.platform !== "darwin" || service.uid === null) {
    const error = service.platform !== "darwin"
      ? "Dome Home lifecycle is supported on macOS launchd only"
      : "cannot determine the current uid for the launchd gui domain";
    return preflightFailure(input.action, vault, deps, service, error);
  }
  if (input.action === "status") {
    try { return await inspectHomeStatus(context, deps); }
    catch (error) {
      const lifecycle = lifecycleRecovery(await inspectHomeLifecycleSuspension(context.vault));
      const base = await selectedBase(context.neutral, context.vault, deps);
      return statusWithLifecycle(result(
        base,
        "error",
        existsSync(context.plist),
        await diagnosticLoaded(context),
        null,
        { error: message(error) },
      ), lifecycle);
    }
  }

  let vaultFailure: string | null;
  try { vaultFailure = await vaultPreflight(vault); }
  catch (error) {
    return result(context.neutral, "error", null, null, null, { error: message(error), exitCode: 64 });
  }
  if (vaultFailure !== null) {
    return result(context.neutral, "error", null, null, null, { error: vaultFailure, exitCode: 64 });
  }
  return manageHomeMutation({
    action: input.action,
    vaultPath: vault,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  }, context, deps);
}

async function manageHomeMutation(
  input: { readonly action: Exclude<HomeLifecycleAction, "status">; readonly vaultPath: string; readonly environment?: ReadonlyMap<string, string> },
  context: HomeContext,
  deps: HomeLifecycleDeps,
): Promise<HomeLifecycleResult> {
  const lifetime: { lease: OperationalWriterLease | null } = { lease: null };
  let provisional: OwnedMutationResult | null = null;
  let output: HomeLifecycleResult;
  try {
    const lifecycle = await withHomeLifecycleMutation(context.vault, async () => {
      await deps.beforeOperationalAdmission?.();
      const admission = await acquireOperationalWriterLease({
        vaultPath: context.vault,
        command: `dome-home-${input.action}`,
      });
      if (!admission.ok) {
        provisional = complete(result(context.neutral, "error", null, null, null, {
          error: operationalAdmissionMessage(admission.error),
          lifecycle: Object.freeze({ state: "inactive" as const }),
        }));
        return provisional;
      }
      lifetime.lease = admission.lease;
      try { provisional = await executeOwnedMutation(input, context, deps); }
      catch (error) {
        provisional = complete(result(context.neutral, "error", null, null, null, {
          error: message(error),
          lifecycle: Object.freeze({ state: "inactive" as const }),
        }));
      }
      await deps.afterOwnedMutation?.();
      return provisional;
    });
    if (lifecycle.kind === "suspended") {
      output = suspendedMutationResult(context.neutral, lifecycle.suspension);
    } else if (lifecycle.value.kind === "complete") {
      output = lifecycle.value.result;
    } else {
      output = await finishReadiness(lifecycle.value, context, deps);
    }
  } catch (error) {
    const inspected = lifecycleRecovery(await inspectHomeLifecycleSuspension(context.vault));
    if (inspected.state === "active" && provisional === null) {
      output = activeMutationResult(context.neutral, inspected);
    } else {
      const recovery = inspected.state === "inactive"
        ? Object.freeze({ state: "unavailable" as const, error: `Home lifecycle coordination failed: ${message(error)}` })
        : inspected;
      output = await mutationCoordinationFailure(provisional, context, recovery, message(error));
    }
  }
  try {
    if (lifetime.lease !== null) {
      (deps.closeOperationalLease ?? ((lease: OperationalWriterLease) => lease.close()))(lifetime.lease);
    }
  }
  catch (error) {
    const recovery = Object.freeze({
      state: "unavailable" as const,
      error: `operational writer lease close failed: ${message(error)}`,
    });
    output = await mutationCoordinationFailure(
      provisional ?? complete(output),
      context,
      recovery,
      recovery.error,
    );
  }
  return output;
}

async function executeOwnedMutation(
  input: { readonly action: Exclude<HomeLifecycleAction, "status">; readonly vaultPath: string; readonly environment?: ReadonlyMap<string, string> },
  context: HomeContext,
  deps: HomeLifecycleDeps,
): Promise<OwnedMutationResult> {
  if (input.action === "install") return executeOwnedInstall(input.environment, context, deps);
  if (input.action === "uninstall") return executeOwnedUninstall(context, deps);
  return executeOwnedStart(input.action, context, deps);
}

async function executeOwnedInstall(
  requestedEnvironment: ReadonlyMap<string, string> | undefined,
  context: HomeContext,
  deps: HomeLifecycleDeps,
): Promise<OwnedMutationResult> {
  const source = invokingArtifactRoot(deps);
  let manifest: HomeArtifactManifest;
  try { manifest = await (deps.verifyArtifact ?? verifyHomeArtifact)(source); }
  catch (error) {
    return complete(result(context.neutral, "error", null, null, null, {
      error: `invoking Dome Home artifact failed verification after lifecycle admission: ${message(error)}`,
    }));
  }
  const installBase = baseForManifest(context.neutral, context.paths, manifest);
  let previous: HomeInstallationRecord | null;
  try { previous = await readHomeInstallation(context.vault, deps); }
  catch (error) {
    return complete(result(installBase, "invalid-installation", existsSync(context.plist), await diagnosticLoaded(context), null, { error: message(error) }));
  }
  const hadPlist = existsSync(context.plist);
  let loaded: boolean;
  try { loaded = await homeLoaded(context); }
  catch (error) { return complete(result(installBase, "error", hadPlist, null, null, { error: message(error) })); }
  if (previous === null && (hadPlist || loaded)) {
    return complete(result(installBase, "orphaned-service", hadPlist, loaded, null, {
      error: "an existing Home service has no managed installation record; run `dome home uninstall` and then `dome home install` for the one-time managed-release cutover",
      exitCode: 64,
    }));
  }
  if (previous !== null && (previous.artifact.id !== manifest.artifact.id ||
    previous.artifact.version !== manifest.product.version)) {
    const selected = baseForRecord(context.neutral, context.paths, previous);
    return complete(result(selected, "error", hadPlist, loaded, null, {
      error: `Dome Home ${previous.artifact.version} (${previous.artifact.id}) is selected; use \`dome home upgrade\` to change artifacts`,
      exitCode: 64,
    }));
  }
  try {
    if (await hasLegacyServeConflict(context, deps.legacyServeRunning)) {
      return complete(legacyConflict(installBase, hadPlist, loaded));
    }
  } catch (error) { return complete(result(installBase, "error", hadPlist, null, null, { error: message(error) })); }
  let readyNow: boolean;
  try { readyNow = await probeHomeReadiness(deps); }
  catch (error) { return complete(result(installBase, "error", hadPlist, loaded, null, { error: message(error) })); }
  if (!loaded && readyNow) return complete(foregroundConflict(installBase, hadPlist));

  if (loaded) {
    const stopped = await stopLoadedHome(context);
    if (stopped !== null) return complete(result(installBase, "error", hadPlist, true, null, { error: stopped }));
  }
  let selected = installBase;
  let releasePublished: boolean | undefined;
  let plistPublished = false;
  try {
    await mkdir(join(context.vault, ".dome", "state"), { recursive: true });
    await mkdir(context.service.launchAgentsDir, { recursive: true });
    const managed = await ensureManagedRelease({
      source,
      manifest,
      paths: context.paths,
      platform: context.service.platform,
    }, deps);
    releasePublished = managed.published;
    const intendedEnvironment = requestedEnvironment ?? new Map(
      previous?.environment.map((entry) => [entry.name, entry.value] as const) ?? [],
    );
    const record = createHomeInstallation(context.vault, manifest, intendedEnvironment);
    await publishHomeInstallation(context.paths.record, record, deps);
    selected = baseForRecord(context.neutral, context.paths, record);
    const environment = new Map<string, string>(intendedEnvironment);
    environment.set("PATH", homeServicePath(join(managed.root, "runtime", "bun")));
    await (deps.publishPlist ?? publishLaunchAgentPlist)(context.plist, renderExpectedPlist(selected, environment));
    plistPublished = true;
    const activation = await activateLaunchAgent({
      launchctl: context.service.launchctl,
      uid: context.service.uid!,
      label: context.label,
      plistPath: context.plist,
    });
    if (activation !== null) {
      return complete(result(selected, "error", true, await diagnosticLoaded(context), false, {
        error: activation,
        replaced: hadPlist,
        releasePublished,
      }));
    }
    return awaitReadiness(selected, "installed", `Dome Home did not become ready at http://${HOME_HOST}:${HOME_PORT}/pair/status`, {
      replaced: hadPlist,
      releasePublished,
    });
  } catch (error) {
    return complete(result(selected, "error", plistPublished || hadPlist, false, null, {
      error: message(error),
      ...(releasePublished === undefined ? {} : { releasePublished }),
    }));
  }
}

async function executeOwnedUninstall(context: HomeContext, deps: HomeLifecycleDeps): Promise<OwnedMutationResult> {
  const selected = await selectedBase(context.neutral, context.vault, deps);
  const hadPlist = existsSync(context.plist);
  let loaded: boolean;
  try { loaded = await homeLoaded(context); }
  catch (error) { return complete(result(selected, "error", hadPlist, null, null, { error: message(error) })); }
  if (loaded) {
    const stopped = await stopLoadedHome(context);
    if (stopped !== null) {
      return complete(result(selected, "error", hadPlist, true, null, {
        error: `${stopped}; plist preserved for retry`,
      }));
    }
  }
  if (!hadPlist) {
    return complete(result(selected, loaded ? "uninstalled" : "not-installed", false, false, null));
  }
  try {
    await (deps.unlinkPlist ?? unlink)(context.plist);
    await (deps.syncPlistParent ?? syncDirectory)(dirname(context.plist));
    return complete(result(selected, "uninstalled", false, false, null));
  } catch (error) {
    return complete(result(selected, "error", existsSync(context.plist), false, null, { error: message(error) }));
  }
}

async function executeOwnedStart(
  action: "start" | "restart",
  context: HomeContext,
  deps: HomeLifecycleDeps,
): Promise<OwnedMutationResult> {
  let record: HomeInstallationRecord | null;
  try { record = await readHomeInstallation(context.vault, deps); }
  catch (error) {
    return complete(result(context.neutral, "invalid-installation", existsSync(context.plist), await diagnosticLoaded(context), null, { error: message(error) }));
  }
  const hasPlist = existsSync(context.plist);
  let loaded: boolean;
  try { loaded = await homeLoaded(context); }
  catch (error) { return complete(result(context.neutral, "error", hasPlist, null, null, { error: message(error) })); }
  if (record === null) {
    return complete(result(context.neutral, "error", hasPlist, loaded, null, {
      error: `not installed (no record at ${context.paths.record}); run \`dome home install\` first`,
      exitCode: 64,
    }));
  }
  const selected = baseForRecord(context.neutral, context.paths, record);
  const integrity = await inspectSelectedRelease(selected, deps);
  if (integrity !== null) return complete(result(selected, integrity.status, hasPlist, loaded, null, { error: integrity.error }));
  if (!hasPlist) {
    return complete(result(selected, "error", false, loaded, null, {
      error: `not installed (no plist at ${context.plist}); run \`dome home install\` first`,
      exitCode: 64,
    }));
  }
  const expectedPlist = renderExpectedPlist(selected, recordEnvironment(record, selected));
  let plistBytes: string;
  try { plistBytes = await readFile(context.plist, "utf8"); }
  catch (error) { return complete(result(selected, "error", true, loaded, null, { error: message(error) })); }
  if (plistBytes !== expectedPlist) {
    return complete(result(selected, "error", true, loaded, null, {
      error: "LaunchAgent plist does not match installation record; run `dome home install` to repair it",
    }));
  }
  try {
    if (await hasLegacyServeConflict(context, deps.legacyServeRunning)) {
      return complete(legacyConflict(selected, true, loaded));
    }
  } catch (error) { return complete(result(selected, "error", true, null, null, { error: message(error) })); }
  let readyNow: boolean;
  try { readyNow = await probeHomeReadiness(deps); }
  catch (error) { return complete(result(selected, "error", true, loaded, null, { error: message(error) })); }
  if (!loaded && readyNow) return complete(foregroundConflict(selected, true));
  if (action === "start" && loaded) {
    return awaitReadiness(selected, "started", "Dome Home is loaded but not ready");
  }
  if (action === "restart" && loaded) {
    const stopped = await stopLoadedHome(context);
    if (stopped !== null) return complete(result(selected, "error", true, true, null, { error: stopped }));
  }
  const activation = await activateLaunchAgent({
    launchctl: context.service.launchctl,
    uid: context.service.uid!,
    label: context.label,
    plistPath: context.plist,
  });
  if (activation !== null) {
    return complete(result(selected, "error", true, await diagnosticLoaded(context), false, { error: activation }));
  }
  return awaitReadiness(selected, action === "restart" ? "restarted" : "started", "Dome Home did not become ready");
}

async function finishReadiness(
  continuation: Extract<OwnedMutationResult, { kind: "await-readiness" }>,
  context: HomeContext,
  deps: HomeLifecycleDeps,
): Promise<HomeLifecycleResult> {
  let ready = false;
  let readinessError: string | null = null;
  try { ready = await waitForHomeReadiness(deps); }
  catch (error) { readinessError = message(error); }
  let loaded: boolean | null;
  let loadedError: string | null = null;
  try { loaded = await homeLoaded(context); }
  catch (error) { loaded = null; loadedError = message(error); }
  const extra = {
    ...(continuation.replaced === undefined ? {} : { replaced: continuation.replaced }),
    ...(continuation.releasePublished === undefined ? {} : { releasePublished: continuation.releasePublished }),
  };
  if (ready && loaded === true) {
    return result(continuation.base, continuation.successStatus, true, true, true, extra);
  }
  const error = [readinessError, ready && loaded === false
    ? "Dome Home became ready but is no longer loaded"
    : continuation.failure, loadedError].filter((value): value is string => value !== null).join("; ");
  return result(continuation.base, "error", true, loaded, ready, { ...extra, error });
}

function complete(value: HomeLifecycleResult): OwnedMutationResult {
  return Object.freeze({ kind: "complete" as const, result: value });
}

function awaitReadiness(
  base: Base,
  successStatus: "installed" | "started" | "restarted",
  failure: string,
  extra: { readonly replaced?: boolean; readonly releasePublished?: boolean } = {},
): OwnedMutationResult {
  return Object.freeze({ kind: "await-readiness" as const, base, successStatus, failure, ...extra });
}

async function inspectHomeStatus(context: HomeContext, deps: HomeLifecycleDeps): Promise<HomeLifecycleResult> {
  const vaultFailure = await vaultPreflight(context.vault);
  if (vaultFailure !== null) {
    const lifecycle = Object.freeze({ state: "unavailable" as const, error: vaultFailure });
    return result(context.neutral, "error", null, null, null, {
      error: vaultFailure,
      exitCode: 64,
      lifecycle,
    });
  }
  const lifecycle = lifecycleRecovery(await inspectHomeLifecycleSuspension(context.vault));
  let record: HomeInstallationRecord | null;
  try { record = await readHomeInstallation(context.vault, deps); }
  catch (error) {
    return statusWithLifecycle(result(
      context.neutral,
      "invalid-installation",
      existsSync(context.plist),
      await diagnosticLoaded(context),
      null,
      { error: message(error) },
    ), lifecycle);
  }
  const base = record === null
    ? context.neutral
    : baseForRecord(context.neutral, context.paths, record);
  const hasPlist = existsSync(context.plist);
  let loaded: boolean;
  try { loaded = await homeLoaded(context); }
  catch (error) {
    return statusWithLifecycle(result(base, "error", hasPlist, null, null, { error: message(error) }), lifecycle);
  }
  if (record === null) {
    const orphaned = hasPlist || loaded;
    let legacyServeConflict: boolean | undefined;
    try { legacyServeConflict = await hasLegacyServeConflict(context, deps.legacyServeRunning); }
    catch (error) {
      return statusWithLifecycle(result(context.neutral, "error", hasPlist, loaded, null, { error: message(error) }), lifecycle);
    }
    return statusWithLifecycle(result(
      context.neutral,
      orphaned ? "orphaned-service" : "not-installed",
      hasPlist,
      loaded,
      null,
      {
        ...(orphaned ? { error: `service exists without its installation record at ${context.paths.record}` } : {}),
        legacyServeConflict,
      },
    ), lifecycle);
  }
  const integrity = await inspectSelectedRelease(base, deps);
  if (integrity !== null) {
    return statusWithLifecycle(result(base, integrity.status, hasPlist, loaded, null, { error: integrity.error }), lifecycle);
  }
  if (!hasPlist) {
    return statusWithLifecycle(loaded
      ? result(base, "orphaned-service", false, true, null, { error: `Dome Home is loaded without its plist at ${context.plist}` })
      : result(base, "not-installed", false, false, null), lifecycle);
  }
  const expectedPlist = renderExpectedPlist(base, recordEnvironment(record, base));
  if (await readFile(context.plist, "utf8") !== expectedPlist) {
    return statusWithLifecycle(result(base, "plist-mismatch", true, loaded, null, {
      error: `LaunchAgent plist does not select artifact ${record.artifact.id}`,
    }), lifecycle);
  }
  const ready = loaded ? await probeHomeReadiness(deps) : null;
  let legacyServeConflict: boolean;
  try { legacyServeConflict = await hasLegacyServeConflict(context, deps.legacyServeRunning); }
  catch (error) {
    return statusWithLifecycle(result(base, "error", true, loaded, ready, { error: message(error) }), lifecycle);
  }
  return statusWithLifecycle(result(
    base,
    loaded ? ready ? "ready" : "loaded-unreachable" : "installed-stopped",
    true,
    loaded,
    ready,
    { legacyServeConflict },
  ), lifecycle);
}

function statusWithLifecycle(
  service: HomeLifecycleResult,
  lifecycle: HomeLifecycleRecovery,
): HomeLifecycleResult {
  if (lifecycle.state === "inactive") return Object.freeze({ ...service, lifecycle });
  const lifecycleError = lifecycleRecoveryMessage(lifecycle);
  return Object.freeze({
    ...service,
    status: "error" as const,
    exitCode: 1 as const,
    lifecycle,
    error: service.error === undefined
      ? lifecycleError
      : `${lifecycleError}; service status: ${service.error}`,
  });
}

function homeContext(
  action: HomeLifecycleAction,
  vault: string,
  service: ReturnType<typeof resolveServiceDeps>,
  deps: HomeLifecycleDeps,
): HomeContext {
  const paths = homeInstallationPaths(vault, deps);
  const label = homeServiceLabelForVault(vault);
  const plist = join(service.launchAgentsDir, `${label}.plist`);
  const log = join(vault, ".dome", "state", "home.log");
  const neutral: Base = {
    schema: HOME_LIFECYCLE_SCHEMA,
    action,
    vault,
    label,
    plist,
    log,
    program: "",
    installation: paths.record,
    release: null,
    artifactId: null,
    productVersion: null,
  };
  return Object.freeze({
    vault,
    service,
    paths,
    label,
    plist,
    log,
    target: service.uid === null ? "" : `gui/${service.uid}/${label}`,
    neutral,
  });
}

function preflightFailure(
  action: HomeLifecycleAction,
  vault: string,
  deps: HomeLifecycleDeps,
  service: ReturnType<typeof resolveServiceDeps> | null,
  error: string,
): HomeLifecycleResult {
  const paths = homeInstallationPaths(vault, deps);
  const label = homeServiceLabelForVault(vault);
  const plist = join(service?.launchAgentsDir ?? resolve(deps.launchAgentsDir ?? ""), `${label}.plist`);
  const base: Base = {
    schema: HOME_LIFECYCLE_SCHEMA,
    action,
    vault,
    label,
    plist,
    log: join(vault, ".dome", "state", "home.log"),
    program: "",
    installation: paths.record,
    release: null,
    artifactId: null,
    productVersion: null,
  };
  if (action !== "status") return result(base, "error", null, null, null, { error, exitCode: 64 });
  const lifecycle = Object.freeze({
    state: error.includes("cannot be canonicalized") ? "invalid" as const : "unavailable" as const,
    error,
  });
  return result(base, "error", null, null, null, { error, exitCode: 64, lifecycle });
}

function lifecycleRecovery(inspection: HomeLifecycleSuspensionInspection): HomeLifecycleRecovery {
  if (inspection.kind === "inactive") return Object.freeze({ state: "inactive" as const });
  if (inspection.kind === "active") {
    return Object.freeze({
      state: "active" as const,
      phase: inspection.suspension.phase,
      purpose: inspection.suspension.purpose,
      operationId: inspection.suspension.operationId,
      lastError: inspection.suspension.lastError,
    });
  }
  return Object.freeze({ state: inspection.kind, error: inspection.error });
}

function suspendedMutationResult(
  base: Base,
  suspension: {
    readonly phase: HomeSuspensionPhase;
    readonly purpose: HomeSuspensionPurpose;
    readonly operationId: string;
    readonly lastError: string | null;
  },
): HomeLifecycleResult {
  return activeMutationResult(base, Object.freeze({
    state: "active" as const,
    phase: suspension.phase,
    purpose: suspension.purpose,
    operationId: suspension.operationId,
    lastError: suspension.lastError,
  }));
}

function activeMutationResult(
  base: Base,
  lifecycle: Extract<HomeLifecycleRecovery, { state: "active" }>,
): HomeLifecycleResult {
  return result(base, "error", null, null, null, {
    error: lifecycleRecoveryMessage(lifecycle),
    lifecycle,
  });
}

async function mutationCoordinationFailure(
  provisional: OwnedMutationResult | null,
  context: HomeContext,
  lifecycle: Exclude<HomeLifecycleRecovery, { state: "inactive" }>,
  detail: string,
): Promise<HomeLifecycleResult> {
  const source = provisional === null
    ? result(context.neutral, "error", null, null, null, { error: detail })
    : provisional.kind === "complete"
      ? provisional.result
      : result(provisional.base, "error", existsSync(provisional.base.plist), await diagnosticLoaded(context), null, {
          error: detail,
          ...(provisional.replaced === undefined ? {} : { replaced: provisional.replaced }),
          ...(provisional.releasePublished === undefined ? {} : { releasePublished: provisional.releasePublished }),
        });
  return Object.freeze({
    ...source,
    status: "error" as const,
    exitCode: 1 as const,
    lifecycle,
    error: source.error === undefined ? detail : `${detail}; operation status: ${source.error}`,
  });
}

function lifecycleRecoveryMessage(lifecycle: Exclude<HomeLifecycleRecovery, { state: "inactive" }>): string {
  if (lifecycle.state === "active") {
    return `Home lifecycle is ${lifecycle.phase} for ${lifecycle.purpose} operation ${lifecycle.operationId}`;
  }
  return `Home lifecycle coordinator is ${lifecycle.state}: ${lifecycle.error}`;
}

async function homeLoaded(context: HomeContext): Promise<boolean> {
  return probeLaunchAgentLoadedStrict({
    launchctl: context.service.launchctl,
    target: context.target,
  });
}

async function diagnosticLoaded(context: HomeContext): Promise<boolean | null> {
  try { return await homeLoaded(context); }
  catch { return null; }
}

async function stopLoadedHome(context: HomeContext): Promise<string | null> {
  let bootout: Awaited<ReturnType<typeof context.service.launchctl>>;
  try { bootout = await context.service.launchctl(["bootout", context.target]); }
  catch (error) { return `launchctl bootout ${context.target} failed: ${message(error)}`; }
  if (bootout.exitCode !== 0) {
    return `launchctl bootout ${context.target} failed: ${launchctlDetail(bootout)}`;
  }
  try {
    const drained = await waitForLaunchAgentDrainStrict({
      launchctl: context.service.launchctl,
      target: context.target,
      timeoutMs: context.service.drainTimeoutMs,
    });
    return drained ? null : "Dome Home did not stop before the launchd drain timeout";
  } catch (error) {
    return `Dome Home drain could not prove the service stopped: ${message(error)}`;
  }
}

function operationalAdmissionMessage(error: OperationalWriterAdmissionError): string {
  return error.kind === "write-admission-closed"
    ? `Dome operational write admission is closed (write-admission-closed) by ${error.transactionId}`
    : `Dome operational writer coordination failed: ${error.cause}`;
}

function launchctlDetail(value: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): string {
  return value.stderr.trim() || value.stdout.trim() || `exit ${value.exitCode}`;
}

function baseForManifest(base: Base, paths: ReturnType<typeof homeInstallationPaths>, manifest: HomeArtifactManifest): Base {
  const release = releaseRoot(paths, manifest.artifact.id);
  return { ...base, release, artifactId: manifest.artifact.id, productVersion: manifest.product.version,
    program: join(release, "app", "bin", "dome") };
}
function baseForRecord(base: Base, paths: ReturnType<typeof homeInstallationPaths>, record: HomeInstallationRecord): Base {
  const release = releaseRoot(paths, record.artifact.id);
  return { ...base, release, artifactId: record.artifact.id, productVersion: record.artifact.version,
    program: join(release, "app", "bin", "dome") };
}
async function selectedBase(base: Base, vault: string, deps: HomeLifecycleDeps): Promise<Base> {
  try {
    const record = await readHomeInstallation(vault, deps);
    return record === null ? base : baseForRecord(base, homeInstallationPaths(vault, deps), record);
  } catch { return base; }
}

async function inspectSelectedRelease(base: Base, deps: HomeLifecycleDeps): Promise<{ status: "missing-release" | "corrupt-release"; error: string } | null> {
  if (base.release === null || !await pathPresent(base.release)) return { status: "missing-release", error: `managed Dome Home release is missing at ${base.release ?? "unknown"}` };
  try {
    const manifest = await (deps.verifyArtifact ?? verifyHomeArtifact)(base.release);
    if (manifest.artifact.id !== base.artifactId || manifest.product.version !== base.productVersion) throw new Error("release manifest differs from installation record");
    return null;
  } catch (error) { return { status: "corrupt-release", error: `managed Dome Home release is corrupt: ${message(error)}` }; }
}

function renderExpectedPlist(base: Base, environment: ReadonlyMap<string, string>): string {
  if (base.release === null) throw new Error("cannot render Home plist without a selected release");
  return renderLaunchAgentPlist({
    label: base.label,
    programArguments: [join(base.release, "runtime", "bun"), join(base.release, "app", "bin", "dome"), "home", "--vault", base.vault,
      "--host", HOME_HOST, "--port", String(HOME_PORT), "--static-dir", join(base.release, "app", "pwa", "dist")],
    workingDirectory: base.vault,
    logPath: base.log,
    environment,
  });
}
function recordEnvironment(record: HomeInstallationRecord, base: Base): ReadonlyMap<string, string> {
  const environment = new Map(record.environment.map((entry) => [entry.name, entry.value] as const));
  if (base.release === null) throw new Error("installation record has no managed release");
  environment.set("PATH", homeServicePath(join(base.release, "runtime", "bun")));
  return environment;
}

function legacyConflict(base: Base, installed: boolean, loaded: boolean | null): HomeLifecycleResult {
  return result(base, "error", installed, loaded, null, { legacyServeConflict: true,
    error: "legacy dome serve service is installed, loaded, or running; run `dome uninstall --vault <vault>` before `dome home install`" });
}
function foregroundConflict(base: Base, installed: boolean): HomeLifecycleResult {
  return result(base, "error", installed, false, true, { error: "Dome Home is already ready on 127.0.0.1:3663 but its LaunchAgent is not loaded; stop the foreground host before continuing" });
}
function result(base: Base, status: HomeLifecycleStatus, installed: boolean | null, loaded: boolean | null, ready: boolean | null,
  extra: Partial<Pick<HomeLifecycleResult, "replaced" | "releasePublished" | "legacyServeConflict" | "lifecycle" | "error" | "exitCode">> = {}): HomeLifecycleResult {
  return Object.freeze({ ...base, status, installed, loaded, ready,
    exitCode: extra.exitCode ?? (["error", "loaded-unreachable", "missing-release", "corrupt-release", "plist-mismatch", "orphaned-service", "invalid-installation"].includes(status) ? 1 : 0), ...extra });
}

async function vaultPreflight(vault: string): Promise<string | null> {
  const gitRoot = await findGitRoot(vault);
  return gitRoot !== vault || !existsSync(join(vault, ".dome", "config.yaml"))
    ? "not an initialized Dome vault; run `dome init` first"
    : null;
}
function invokingArtifactRoot(deps: HomeLifecycleDeps): string { return resolve(deps.artifactRoot ?? resolve(import.meta.dir, "../../..")); }
function homeServicePath(runtimePath: string): string { return [dirname(runtimePath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((value, index, all) => all.indexOf(value) === index).join(":"); }
async function hasLegacyServeConflict(
  context: HomeContext,
  injected?: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const legacyLabel = serviceLabelForVault(context.vault);
  if (existsSync(join(context.service.launchAgentsDir, `${legacyLabel}.plist`))) return true;
  if (injected === undefined
    ? (await readServeHeartbeatStatus({ vaultPath: context.vault })).status === "running"
    : await injected()) return true;
  return probeLaunchAgentLoadedStrict({
    launchctl: context.service.launchctl,
    target: `gui/${context.service.uid!}/${legacyLabel}`,
  });
}
async function waitForHomeReadiness(deps: HomeLifecycleDeps): Promise<boolean> {
  const deadline = Date.now() + (deps.readinessTimeoutMs ?? 10_000);
  do { if (await probeHomeReadiness(deps)) return true; await new Promise((resolvePromise) => setTimeout(resolvePromise, 200)); } while (Date.now() < deadline);
  return false;
}
async function probeHomeReadiness(deps: HomeLifecycleDeps): Promise<boolean> {
  if (deps.readiness !== undefined) return deps.readiness();
  try { return await isHomePairingReadiness(await fetch(`http://${HOME_HOST}:${HOME_PORT}/pair/status`)); } catch { return false; }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function pathPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
