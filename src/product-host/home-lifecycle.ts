// product-host/home-lifecycle: supervised macOS Dome Home lifecycle over one
// closed per-vault installation record and immutable managed releases.

import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { findGitRoot } from "../git";
import { readServeHeartbeatStatus } from "../engine/host/compiler-host-heartbeat";
import { acquireOperationalWriterLease } from "../operational-state/writer-barrier";
import {
  activateLaunchAgent,
  publishLaunchAgentPlist,
  renderLaunchAgentPlist,
  waitForLaunchAgentDrain,
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

export const HOME_LIFECYCLE_SCHEMA = "dome.home.lifecycle/v1" as const;
const HOME_HOST = "127.0.0.1";
const HOME_PORT = 3663;

export type HomeLifecycleAction = "install" | "start" | "restart" | "status" | "uninstall";
export type HomeLifecycleStatus =
  | "installed" | "started" | "restarted" | "ready" | "loaded-unreachable"
  | "installed-stopped" | "not-installed" | "uninstalled" | "missing-release"
  | "corrupt-release" | "plist-mismatch" | "orphaned-service" | "invalid-installation" | "error";

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
  readonly installed: boolean;
  readonly loaded: boolean | null;
  readonly ready: boolean | null;
  readonly replaced?: boolean;
  readonly releasePublished?: boolean;
  readonly legacyServeConflict?: boolean;
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
};

type Base = Pick<HomeLifecycleResult,
  "schema" | "action" | "vault" | "label" | "plist" | "log" | "program" |
  "installation" | "release" | "artifactId" | "productVersion">;

export function homeServiceLabelForVault(vaultPath: string): string {
  return `com.dome.home.${vaultServiceSlug(vaultPath)}`;
}

export async function manageHome(input: {
  readonly action: HomeLifecycleAction;
  readonly vaultPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}, deps: HomeLifecycleDeps = {}): Promise<HomeLifecycleResult> {
  const requestedVault = resolve(input.vaultPath);
  let vault = requestedVault;
  try { vault = await realpath(requestedVault); } catch { /* structured failure below */ }
  try { return await manageHomeInner({ ...input, vaultPath: vault }, deps); }
  catch (error) {
    const d = resolveServiceDeps(deps);
    const base = await fallbackBase(input.action, vault, deps);
    return result(base, "error", existsSync(base.plist), d.platform === "darwin" && d.uid !== null
      ? await probeLoaded(d, d.uid, base.label) : null, null, { error: message(error) });
  }
}

async function manageHomeInner(input: {
  readonly action: HomeLifecycleAction;
  readonly vaultPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}, deps: HomeLifecycleDeps): Promise<HomeLifecycleResult> {
  const vault = input.vaultPath;
  const d = resolveServiceDeps(deps);
  const paths = homeInstallationPaths(vault, deps);
  const label = homeServiceLabelForVault(vault);
  const plist = join(d.launchAgentsDir, `${label}.plist`);
  const log = join(vault, ".dome", "state", "home.log");
  const neutral: Base = { schema: HOME_LIFECYCLE_SCHEMA, action: input.action, vault, label, plist, log,
    program: "", installation: paths.record, release: null, artifactId: null, productVersion: null };
  if (d.platform !== "darwin" || d.uid === null) return result(neutral, "error", false, false, null, {
    error: d.platform !== "darwin" ? "Dome Home lifecycle is supported on macOS launchd only" : "cannot determine the current uid for the launchd gui domain",
  });
  const uid = d.uid;
  const target = `gui/${uid}/${label}`;

  if (input.action === "uninstall") {
    return withHomeLifecycleWriterLease(neutral, vault, input.action, async () => {
      const loaded = await probeLoaded(d, uid, label) === true;
      await d.launchctl(["bootout", target]);
      const drained = await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });
      if (!drained) return result(await selectedBase(neutral, vault, deps), "error", existsSync(plist), true, null, { error: "Dome Home did not stop before the launchd drain timeout; plist preserved for retry" });
      const hadPlist = existsSync(plist);
      if (hadPlist) {
        await (deps.unlinkPlist ?? unlink)(plist);
        await (deps.syncPlistParent ?? syncDirectory)(dirname(plist));
      }
      return result(await selectedBase(neutral, vault, deps), hadPlist || loaded ? "uninstalled" : "not-installed", false, false, null);
    });
  }

  if (input.action === "install") {
    const vaultFailure = await vaultPreflight(vault);
    if (vaultFailure !== null) return result(neutral, "error", false, false, null, { error: vaultFailure, exitCode: 64 });
    const source = invokingArtifactRoot(deps);
    let manifest: HomeArtifactManifest;
    try { manifest = await (deps.verifyArtifact ?? verifyHomeArtifact)(source); }
    catch (error) { return result(neutral, "error", existsSync(plist), false, null, { error: `invoking Dome Home artifact failed verification: ${message(error)}` }); }
    const installBase = baseForManifest(neutral, paths, manifest);
    let previous: HomeInstallationRecord | null;
    try { previous = await readHomeInstallation(vault, deps); }
    catch (error) { return result(installBase, "invalid-installation", existsSync(plist), await probeLoaded(d, uid, label), null, { error: message(error) }); }
    const loaded = await probeLoaded(d, uid, label) === true;
    if (previous === null && (existsSync(plist) || loaded)) {
      return result(installBase, "orphaned-service", existsSync(plist), loaded, null, {
        error: "an existing Home service has no managed installation record; run `dome home uninstall` and then `dome home install` for the one-time managed-release cutover",
        exitCode: 64,
      });
    }
    if (previous !== null && previous.artifact.id !== manifest.artifact.id) {
      return result(baseForRecord(neutral, paths, previous), "error", existsSync(plist), await probeLoaded(d, uid, label), null, {
        error: `Dome Home ${previous.artifact.version} (${previous.artifact.id}) is selected; use \`dome home upgrade\` to change artifacts`,
        exitCode: 64,
      });
    }
    const readyNow = await probeHomeReadiness(deps);
    const hadPlist = existsSync(plist);
    if (await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning)) return legacyConflict(installBase, hadPlist, loaded);
    if (!loaded && readyNow) return foregroundConflict(installBase, hadPlist);
    return withHomeLifecycleWriterLease(installBase, vault, input.action, async () => {
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(d.launchAgentsDir, { recursive: true });
      await d.launchctl(["bootout", target]);
      const drained = await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });
      if (!drained) return result(installBase, "error", hadPlist, true, null, { error: "Dome Home did not stop before the launchd drain timeout" });
      const managed = await ensureManagedRelease({ source, manifest, paths, platform: d.platform }, deps);
      const intendedEnvironment = input.environment ?? new Map(previous?.environment.map((entry) => [entry.name, entry.value] as const) ?? []);
      const environment = new Map<string, string>(intendedEnvironment);
      const record = createHomeInstallation(vault, manifest, intendedEnvironment);
      await publishHomeInstallation(paths.record, record, deps);
      const selected = baseForRecord(neutral, paths, record);
      environment.set("PATH", homeServicePath(join(managed.root, "runtime", "bun")));
      await (deps.publishPlist ?? publishLaunchAgentPlist)(plist, renderExpectedPlist(selected, environment));
      const activation = await activateLaunchAgent({ launchctl: d.launchctl, uid, label, plistPath: plist });
      if (activation !== null) return result(selected, "error", true, await probeLoaded(d, uid, label), false, { error: activation, replaced: hadPlist, releasePublished: managed.published });
      const ready = await waitForHomeReadiness(deps);
      if (!ready) return result(selected, "error", true, await probeLoaded(d, uid, label), false, { error: `Dome Home did not become ready at http://${HOME_HOST}:${HOME_PORT}/pair/status`, replaced: hadPlist, releasePublished: managed.published });
      return result(selected, "installed", true, true, true, { replaced: hadPlist, releasePublished: managed.published });
    });
  }

  let record: HomeInstallationRecord | null;
  try { record = await readHomeInstallation(vault, deps); }
  catch (error) {
    return result(neutral, "invalid-installation", existsSync(plist), await probeLoaded(d, uid, label), null, { error: message(error) });
  }
  const loaded = await probeLoaded(d, uid, label) === true;
  if (record === null) {
    if (input.action === "status") {
      const orphaned = existsSync(plist) || loaded;
      return result(neutral, orphaned ? "orphaned-service" : "not-installed", existsSync(plist), loaded, null, {
        ...(orphaned ? { error: `service exists without its installation record at ${paths.record}` } : {}),
        legacyServeConflict: await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning),
      });
    }
    return result(neutral, "error", existsSync(plist), loaded, null, { error: `not installed (no record at ${paths.record}); run \`dome home install\` first`, exitCode: 64 });
  }
  const selected = baseForRecord(neutral, paths, record);
  const hasPlist = existsSync(plist);
  const integrity = await inspectSelectedRelease(selected, deps);
  if (integrity !== null) return result(selected, integrity.status, hasPlist, loaded, null, { error: integrity.error });
  const expectedPlist = renderExpectedPlist(selected, recordEnvironment(record, selected));
  const plistMatches = hasPlist && await readFile(plist, "utf8") === expectedPlist;
  if (input.action === "status") {
    if (!hasPlist) return loaded
      ? result(selected, "orphaned-service", false, true, null, { error: `Dome Home is loaded without its plist at ${plist}` })
      : result(selected, "not-installed", false, false, null);
    if (!plistMatches) return result(selected, "plist-mismatch", true, loaded, null, { error: `LaunchAgent plist does not select artifact ${record.artifact.id}` });
    const ready = loaded ? await probeHomeReadiness(deps) : null;
    return result(selected, loaded ? ready ? "ready" : "loaded-unreachable" : "installed-stopped", true, loaded, ready, {
      legacyServeConflict: await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning),
    });
  }
  if (!hasPlist) return result(selected, "error", false, loaded, null, { error: `not installed (no plist at ${plist}); run \`dome home install\` first`, exitCode: 64 });
  if (!plistMatches) return result(selected, "error", true, loaded, null, { error: `LaunchAgent plist does not match installation record; run \`dome home install\` to repair it` });
  if (await hasLegacyServeConflict(vault, d, uid, deps.legacyServeRunning)) return legacyConflict(selected, true, loaded);
  const readyNow = await probeHomeReadiness(deps);
  if (!loaded && readyNow) return foregroundConflict(selected, true);
  return withHomeLifecycleWriterLease(selected, vault, input.action, async () => {
    if (input.action === "restart") {
      await d.launchctl(["bootout", target]);
      const drained = await waitForLaunchAgentDrain({ launchctl: d.launchctl, uid, label, timeoutMs: d.drainTimeoutMs });
      if (!drained) return result(selected, "error", true, true, null, { error: "Dome Home did not stop before the launchd drain timeout" });
    } else if (loaded) {
      const ready = await waitForHomeReadiness(deps);
      return ready ? result(selected, "started", true, true, true) : result(selected, "error", true, true, false, { error: "Dome Home is loaded but not ready" });
    }
    const activation = await activateLaunchAgent({ launchctl: d.launchctl, uid, label, plistPath: plist });
    if (activation !== null) return result(selected, "error", true, await probeLoaded(d, uid, label), false, { error: activation });
    const ready = await waitForHomeReadiness(deps);
    if (!ready) return result(selected, "error", true, await probeLoaded(d, uid, label), false, { error: "Dome Home did not become ready" });
    return result(selected, input.action === "restart" ? "restarted" : "started", true, true, true);
  });
}

async function withHomeLifecycleWriterLease(
  base: Base,
  vault: string,
  action: Exclude<HomeLifecycleAction, "status">,
  operation: () => Promise<HomeLifecycleResult>,
): Promise<HomeLifecycleResult> {
  const admission = await acquireOperationalWriterLease({
    vaultPath: vault,
    command: `dome-home-${action}`,
  });
  if (!admission.ok) {
    return result(base, "error", existsSync(base.plist), null, null, {
      error: `Dome operational write admission is closed: ${admission.error.kind}`,
    });
  }
  try { return await operation(); }
  finally { admission.lease.close(); }
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
async function fallbackBase(action: HomeLifecycleAction, vault: string, deps: HomeLifecycleDeps): Promise<Base> {
  const d = resolveServiceDeps(deps);
  const label = homeServiceLabelForVault(vault);
  const paths = homeInstallationPaths(vault, deps);
  const base: Base = { schema: HOME_LIFECYCLE_SCHEMA, action, vault, label, plist: join(d.launchAgentsDir, `${label}.plist`),
    log: join(vault, ".dome", "state", "home.log"), program: "", installation: paths.record,
    release: null, artifactId: null, productVersion: null };
  return selectedBase(base, vault, deps);
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
function result(base: Base, status: HomeLifecycleStatus, installed: boolean, loaded: boolean | null, ready: boolean | null,
  extra: Partial<Pick<HomeLifecycleResult, "replaced" | "releasePublished" | "legacyServeConflict" | "error" | "exitCode">> = {}): HomeLifecycleResult {
  return Object.freeze({ ...base, status, installed, loaded, ready,
    exitCode: extra.exitCode ?? (["error", "loaded-unreachable", "missing-release", "corrupt-release", "plist-mismatch", "orphaned-service", "invalid-installation"].includes(status) ? 1 : 0), ...extra });
}

async function vaultPreflight(vault: string): Promise<string | null> {
  const gitRoot = await findGitRoot(vault);
  return gitRoot === null || !existsSync(join(vault, ".dome", "config.yaml")) ? "not an initialized Dome vault; run `dome init` first" : null;
}
function invokingArtifactRoot(deps: HomeLifecycleDeps): string { return resolve(deps.artifactRoot ?? resolve(import.meta.dir, "../../..")); }
function homeServicePath(runtimePath: string): string { return [dirname(runtimePath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((value, index, all) => all.indexOf(value) === index).join(":"); }
async function hasLegacyServeConflict(vault: string, d: ReturnType<typeof resolveServiceDeps>, uid: number, injected?: (() => Promise<boolean>) | undefined): Promise<boolean> {
  const legacyLabel = serviceLabelForVault(vault);
  if (existsSync(join(d.launchAgentsDir, `${legacyLabel}.plist`))) return true;
  if (injected === undefined ? (await readServeHeartbeatStatus({ vaultPath: vault })).status === "running" : await injected()) return true;
  return (await d.launchctl(["print", `gui/${uid}/${legacyLabel}`])).exitCode === 0;
}
async function probeLoaded(d: ReturnType<typeof resolveServiceDeps>, uid: number, label: string): Promise<boolean | null> {
  try { return (await d.launchctl(["print", `gui/${uid}/${label}`])).exitCode === 0; } catch { return null; }
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
export async function isHomePairingReadiness(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const payload = await response.json() as { readonly schema?: unknown; readonly available?: unknown; readonly paired?: unknown };
    return payload.schema === "dome.device.pairing/v1" && payload.available === true && typeof payload.paired === "boolean";
  } catch { return false; }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function pathPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
