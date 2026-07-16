// Read-only, path-free discovery of legacy at-rest credential persistence for
// one Dome Home vault. Runtime process state is deliberately out of scope.

import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { compareStrings } from "../core/compare";
import { probeLaunchAgentLoadedStrict } from "../platform/launchd";
import { resolveServiceDeps, vaultServiceSlug } from "../surface/service-probe";
import { ensureManagedHomeRuntimeOwned, homeInstallationPaths, parseHomeInstallationRecord, readHomeInstallation, releaseRoot, syncDirectory, type HomeInstallationDeps } from "./home-installation";
import { captureHomeSelectionDocument, homeSelectionPaths, publishHomeSelectionDocument, renderHomeSelection, type HomeSelectionDeps } from "./home-selection";
import {
  readHomeUpgrade,
  readHomeUpgradeDisposition,
  readHomeUpgradeHistory,
  type HomeUpgradeSelectionEvidence,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";
import { isHomeSecretEnvironmentName, openHomeCredentials, type HomeCredentials } from "./home-credentials";
import { resolveHomeModelRuntime, type HomeModelRuntime } from "./home-model-provider";
import {
  assertHomeStoppedForLifecycleMutation,
  inspectHomeLifecycleSuspension,
  withHomeLifecycleMutation,
  withSupervisedHomeSuspended,
  type HomeLifecycleSuspensionDeps,
  type HomeLifecycleSuspensionInspection,
  type SupervisedHomeSuspensionResult,
} from "./home-lifecycle-suspension";
import { withProductHostOwnership } from "./host-ownership";
import { withManagedReleaseStoreCoordinator, type ManagedReleaseStoreOwner } from "./managed-release-store-coordinator";
import { verifyHomeArtifact } from "./home-artifact";
import { readVaultId } from "./vault-id";

export const HOME_CREDENTIAL_RESIDUE_SCHEMA = "dome.home.credential-residue/v1" as const;
export type HomeCredentialResidueSurface = "live" | "transient" | "active" | "history";
export type HomeCredentialResidueDocument = "installation" | "plist";
export type HomeCredentialResidueFinding = Readonly<{
  surface: HomeCredentialResidueSurface;
  document: HomeCredentialResidueDocument;
  variableName: string;
}>;
type InspectionBase = Readonly<{
  schema: typeof HOME_CREDENTIAL_RESIDUE_SCHEMA;
  atRest: true;
  runtime: "unknown";
}>;
export type HomeCredentialResidueInspection = InspectionBase & (
  | Readonly<{ state: "clean" | "residue"; findings: ReadonlyArray<HomeCredentialResidueFinding> }>
  | Readonly<{
    state: "indeterminate";
    findings: null;
    reason: "verification-failed" | "inventory-limit" | "changed";
  }>
);

export type HomeCredentialResidueDeps = Pick<HomeInstallationDeps, "applicationSupportDir"> &
  Pick<HomeSelectionDeps, "launchAgentsDir"> &
  Pick<HomeUpgradeTransactionDeps, "journalReadCheckpoint"> & {
    /** Test-only race seam between the two complete read-only scans. */
    readonly credentialResidueBetweenScans?: (() => Promise<void>) | undefined;
  };

export const HOME_CREDENTIAL_CLEANUP_SCHEMA = "dome.home.credential-residue-cleanup/v1" as const;
export const HOME_CREDENTIAL_CLEANUP_AUTHORIZATION = "discard-legacy-anthropic-plaintext" as const;
export type HomeCredentialResidueCleanupResult = Readonly<{
  schema: typeof HOME_CREDENTIAL_CLEANUP_SCHEMA;
  mode: "preview" | "apply";
  status: "clean" | "residue" | "cleaned" | "blocked" | "recovery-required" | "error";
  cleanup: "clean" | "residue" | "indeterminate";
  home: "not-run" | "ready" | "stopped" | "recovery-required";
  reason: "authorization-required" | "unsupported-residue" | "configure-shipped-model" |
    "configure-keychain" | "recover-upgrade" | "lifecycle-busy" | "verification-failed" |
    "cleanup-incomplete" | "resume-failed" | null;
  nextAction: "none" | "rerun-with-apply" | "configure-model" | "recover-upgrade" |
    "retry-cleanup" | "inspect-residue";
  message: string;
  exitCode: 0 | 1 | 64 | 75;
}>;

export type HomeCredentialResidueCleanupDeps = HomeCredentialResidueDeps &
  Pick<HomeInstallationDeps, "verifyArtifact" | "publishRuntime" | "syncRuntimeParent" |
    "directoryDurabilityCheckpoint"> &
  Pick<HomeLifecycleSuspensionDeps, "platform" | "uid" | "launchctl" | "drainTimeoutMs" |
    "readiness" | "readinessTimeoutMs" | "legacyServeRunning"> & {
    readonly credentials?: HomeCredentials;
    readonly resolveModel?: ((vaultPath: string) => Promise<HomeModelRuntime>) | undefined;
    readonly inspectLifecycle?: ((vaultPath: string) => Promise<HomeLifecycleSuspensionInspection>) | undefined;
    readonly readUpgrade?: ((vaultPath: string) => Promise<Awaited<ReturnType<typeof readHomeUpgradeDisposition>>>) | undefined;
    readonly suspend?: typeof withSupervisedHomeSuspended | undefined;
    readonly mutateLifecycle?: typeof withHomeLifecycleMutation | undefined;
    readonly isServiceLoaded?: ((vaultPath: string) => Promise<boolean>) | undefined;
    readonly proveStopped?: ((vaultPath: string) => Promise<void>) | undefined;
    readonly operationId?: (() => string) | undefined;
    readonly cleanupCheckpoint?: ((name: "installation-published" | "plist-published" |
      "transient-renamed" | "history-renamed" | "before-final-inspection") => Promise<void>) | undefined;
  };

const MAX_NAMES = 128;
const MAX_FINDINGS = 128;

class InspectionFailure extends Error {
  readonly reason: "verification-failed" | "inventory-limit" | "changed";
  constructor(reason: "verification-failed" | "inventory-limit" | "changed") {
    super("Home credential residue inspection is indeterminate");
    this.reason = reason;
  }
}

type ScanContext = {
  readonly findings: Map<string, HomeCredentialResidueFinding>;
  readonly snapshot: Map<string, string>;
};

export async function inspectHomeCredentialResidue(
  vaultPath: string,
  deps: HomeCredentialResidueDeps = {},
): Promise<HomeCredentialResidueInspection> {
  try { return await inspectResidue(vaultPath, deps); }
  catch (error) {
    return indeterminate(error instanceof InspectionFailure ? error.reason : "verification-failed");
  }
}

async function inspectResidue(
  vaultPath: string,
  deps: HomeCredentialResidueDeps,
): Promise<HomeCredentialResidueInspection> {
  const vault = resolve(vaultPath);
  await readVaultId(vault);
  const first = await scanPass(vault, deps);
  await deps.credentialResidueBetweenScans?.();
  let second: ScanContext;
  try { second = await scanPass(vault, deps); }
  catch { throw new InspectionFailure("changed"); }
  if (stableScan(first) !== stableScan(second)) throw new InspectionFailure("changed");
  return complete(second.findings);
}

async function scanPass(vault: string, deps: HomeCredentialResidueDeps): Promise<ScanContext> {
  const context: ScanContext = { findings: new Map(), snapshot: new Map() };
  const paths = homeInstallationPaths(vault, deps);
  const selectionPaths = homeSelectionPaths(vault, deps);
  if (await present(context, paths.installations)) {
    await assertHomeDirectoryChain(context, paths.root, paths.installations);
  }
  if (await present(context, dirname(selectionPaths.plist))) {
    await assertLaunchAgentsParent(context, dirname(selectionPaths.plist));
  }
  const liveInstallation = await present(context, paths.record);
  const livePlist = await present(context, selectionPaths.plist);
  if (!liveInstallation && livePlist) throw new InspectionFailure("verification-failed");
  if (liveInstallation) {
    await scanInstallation(context, paths.record, vault, "live");
  }
  if (livePlist) {
    await scanPlist(context, selectionPaths.plist, "live");
  }
  await scanTemporarySiblings(context, paths.record, selectionPaths.plist, vault);
  await scanUpgradeState(context, vault, paths.installations, deps);
  return context;
}

async function scanTemporarySiblings(
  context: ScanContext,
  installationPath: string,
  plistPath: string,
  vault: string,
): Promise<void> {
  const installationParent = dirname(installationPath);
  if (await present(context, installationParent)) {
    const names = await boundedNames(context, installationParent, 0o700);
    for (const name of names.filter((name) => name.startsWith(`${basename(installationPath)}.tmp-`) ||
      /^\.credential-cleanup-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-installation$/.test(name))) {
      await scanInstallation(context, join(installationParent, name), vault, "transient");
    }
  }
  const plistParent = dirname(plistPath);
  if (await present(context, plistParent)) {
    const names = await boundedNames(context, plistParent, null);
    for (const name of names.filter((name) => name.startsWith(`${basename(plistPath)}.tmp-`) ||
      /^\.credential-cleanup-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-plist$/.test(name))) {
      await scanPlist(context, join(plistParent, name), "transient");
    }
  }
}

async function scanUpgradeState(
  context: ScanContext,
  vault: string,
  installations: string,
  deps: HomeCredentialResidueDeps,
): Promise<void> {
  const upgrade = join(installations, "upgrade");
  if (!await present(context, upgrade)) return;
  const before = await boundedNames(context, upgrade, 0o700);
  for (const name of before.filter(isStagingCleanupTombstone)) {
    await boundedNames(context, join(upgrade, name), 0o700);
    addNames(context.findings, "transient", "installation", ["ANTHROPIC_API_KEY"]);
  }
  for (const name of before.filter((name) => name.startsWith(".staging-"))) {
    await scanStaging(context, join(upgrade, name), vault);
  }
  const activePath = join(upgrade, "active");
  const active = await present(context, activePath) ? await readHomeUpgrade(vault, deps) : null;
  if (active !== null) {
    await boundedNames(context, activePath, 0o700);
    await capturePrivate(context, join(activePath, "journal.json"));
    context.snapshot.set("journal:active", JSON.stringify(active));
  }
  if (active?.selection !== null && active?.selection !== undefined) {
    await scanStoredSelection(context, join(upgrade, "active"), active.selection, "active", vault);
  }
  const history = join(upgrade, "history");
  if (await present(context, history)) {
    const historyNames = await boundedNames(context, history, 0o700);
    for (const transactionId of historyNames) {
      if (isHistoryCleanupTombstone(transactionId)) {
        await boundedNames(context, join(history, transactionId), 0o700);
        addNames(context.findings, "transient", "installation", ["ANTHROPIC_API_KEY"]);
        continue;
      }
      const root = join(history, transactionId);
      await boundedNames(context, root, 0o700);
      const journal = await readHomeUpgradeHistory(vault, transactionId, deps);
      if (journal === null) throw new InspectionFailure("changed");
      await capturePrivate(context, join(root, "journal.json"));
      context.snapshot.set(`journal:history:${transactionId}`, JSON.stringify(journal));
      if (journal.selection !== null) {
        await scanStoredSelection(context, root, journal.selection, "history", vault);
      }
    }
  }
}

async function scanStaging(
  context: ScanContext,
  root: string,
  vault: string,
): Promise<void> {
  const names = await boundedNames(context, root, 0o700);
  const allowed = new Set(["journal.json", "selectors", "snapshot"]);
  if (names.some((name) => !allowed.has(name))) throw new InspectionFailure("verification-failed");
  const selectors = join(root, "selectors");
  if (!await present(context, selectors)) return;
  const selectorNames = await boundedNames(context, selectors, 0o700);
  const allowedSelectors = new Set([
    "old-installation.json", "old.plist", "candidate-installation.json", "candidate.plist",
  ]);
  if (selectorNames.some((name) => !allowedSelectors.has(name))) throw new InspectionFailure("verification-failed");
  for (const name of selectorNames) {
    if (name.endsWith("installation.json")) await scanInstallation(context, join(selectors, name), vault, "transient");
    else await scanPlist(context, join(selectors, name), "transient");
  }
}

async function scanStoredSelection(
  context: ScanContext,
  root: string,
  selection: HomeUpgradeSelectionEvidence,
  surface: "active" | "history",
  vault: string,
): Promise<void> {
  await boundedNames(context, join(root, "selectors"), 0o700);
  for (const side of ["old", "candidate"] as const) {
    const installation = selection[side].installation;
    await assertEvidence(context, join(root, installation.stored), installation);
    await scanInstallation(context, join(root, installation.stored), vault, surface);
    const plist = selection[side].plist;
    await assertEvidence(context, join(root, plist.stored), plist);
    await scanPlist(context, join(root, plist.stored), surface);
  }
}

async function assertEvidence(
  context: ScanContext,
  path: string,
  evidence: HomeUpgradeSelectionEvidence["old"]["installation"],
): Promise<void> {
  const captured = await capturePrivate(context, path);
  if (captured.sha256 !== evidence.sha256 || captured.size !== evidence.size || captured.mode !== evidence.mode) {
    throw new InspectionFailure("changed");
  }
}

async function scanInstallation(
  context: ScanContext,
  path: string,
  vault: string,
  surface: HomeCredentialResidueSurface,
): Promise<void> {
  const captured = await capturePrivate(context, path);
  let value: unknown;
  try { value = JSON.parse(captured.bytes); }
  catch { throw new InspectionFailure("verification-failed"); }
  const record = parseHomeInstallationRecord(value, vault);
  addNames(context.findings, surface, "installation", record.environment.map((entry) => entry.name));
}

async function scanPlist(
  context: ScanContext,
  path: string,
  surface: HomeCredentialResidueSurface,
): Promise<void> {
  addNames(context.findings, surface, "plist", parsePlistEnvironmentNames((await capturePrivate(context, path)).bytes));
}

async function capturePrivate(context: ScanContext, path: string) {
  const before = await lstat(path, { bigint: true });
  const captured = await captureHomeSelectionDocument(path, "Dome Home credential residue document");
  const after = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
    before.uid !== ownerUid() || captured.mode !== 0o600 ||
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new InspectionFailure("verification-failed");
  }
  context.snapshot.set(`file:${path}`, [before.dev, before.ino, before.size, captured.sha256].join(":"));
  return captured;
}

function addNames(
  findings: Map<string, HomeCredentialResidueFinding>,
  surface: HomeCredentialResidueSurface,
  document: HomeCredentialResidueDocument,
  names: ReadonlyArray<string>,
): void {
  for (const variableName of names) {
    if (variableName.length === 0 || variableName.length > 256 || variableName.includes("\0")) {
      throw new InspectionFailure("verification-failed");
    }
    if (!isHomeSecretEnvironmentName(variableName)) continue;
    const finding = Object.freeze({ surface, document, variableName });
    findings.set(`${surface}\0${document}\0${variableName}`, finding);
    if (findings.size > MAX_FINDINGS) throw new InspectionFailure("inventory-limit");
  }
}

function parsePlistEnvironmentNames(bytes: string): ReadonlyArray<string> {
  const plist = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\n<plist version="1\.0">\n<dict>\n  <key>Label<\/key>\n  <string>([^<]*)<\/string>\n(?:  <key>Program<\/key>\n  <string>([^<]*)<\/string>\n)?  <key>ProgramArguments<\/key>\n  <array>\n((?:    <string>[^<]*<\/string>\n)+)  <\/array>\n  <key>EnvironmentVariables<\/key>\n  <dict>\n((?:    <key>[^<]*<\/key>\n    <string>[^<]*<\/string>\n)*)  <\/dict>\n  <key>WorkingDirectory<\/key>\n  <string>([^<]*)<\/string>\n  <key>RunAtLoad<\/key>\n  <true\/>\n  <key>KeepAlive<\/key>\n  <true\/>\n  <key>StandardOutPath<\/key>\n  <string>([^<]*)<\/string>\n  <key>StandardErrorPath<\/key>\n  <string>([^<]*)<\/string>\n<\/dict>\n<\/plist>\n$/.exec(bytes);
  if (plist === null) throw new InspectionFailure("verification-failed");
  decodeXml(plist[1]!);
  if (plist[2] !== undefined) decodeXml(plist[2]);
  for (const argument of plist[3]!.matchAll(/    <string>([^<]*)<\/string>\n/g)) decodeXml(argument[1]!);
  decodeXml(plist[5]!);
  const stdout = decodeXml(plist[6]!);
  if (decodeXml(plist[7]!) !== stdout) throw new InspectionFailure("verification-failed");
  const body = plist[4]!;
  const names: string[] = [];
  for (const match of body.matchAll(/    <key>([^<]*)<\/key>\n    <string>([^<]*)<\/string>\n/g)) {
    names.push(decodeXml(match[1]!));
    decodeXml(match[2]!);
  }
  if (new Set(names).size !== names.length) throw new InspectionFailure("verification-failed");
  return Object.freeze(names);
}

function decodeXml(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) throw new InspectionFailure("verification-failed");
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'");
}

async function boundedNames(
  context: ScanContext,
  path: string,
  requiredMode: 0o700 | null,
): Promise<ReadonlyArray<string>> {
  const info = await assertOwnedDirectory(path, requiredMode);
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > MAX_NAMES) throw new InspectionFailure("inventory-limit");
  if (entries.some((entry) => entry.isSymbolicLink())) throw new InspectionFailure("verification-failed");
  const names = Object.freeze(entries.map((entry) => entry.name).sort(compareStrings));
  context.snapshot.set(`directory:${path}`, [info.dev, info.ino, info.mode & 0o777, ...names].join(":"));
  return names;
}

async function assertHomeDirectoryChain(
  context: ScanContext,
  root: string,
  installations: string,
): Promise<void> {
  for (const path of [root, join(root, "installations"), installations]) {
    const info = await assertOwnedDirectory(path, 0o700);
    context.snapshot.set(`directory-identity:${path}`, `${info.dev}:${info.ino}:${info.mode & 0o777}`);
  }
}

async function assertLaunchAgentsParent(context: ScanContext, path: string): Promise<void> {
  const info = await assertOwnedDirectory(path, null);
  if ((info.mode & 0o022) !== 0) throw new InspectionFailure("verification-failed");
  context.snapshot.set(`directory-identity:${path}`, `${info.dev}:${info.ino}:${info.mode & 0o777}`);
}

async function assertOwnedDirectory(path: string, requiredMode: 0o700 | null) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== Number(ownerUid()) ||
    (requiredMode !== null && (info.mode & 0o777) !== requiredMode) ||
    await realpath(path) !== resolve(path)) {
    throw new InspectionFailure("verification-failed");
  }
  return info;
}

async function present(context: ScanContext, path: string): Promise<boolean> {
  try {
    const info = await lstat(path, { bigint: true });
    context.snapshot.set(`presence:${path}`, `${info.dev}:${info.ino}:${info.mode}:${info.size}`);
    return true;
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      context.snapshot.set(`presence:${path}`, "absent");
      return false;
    }
    throw error;
  }
}

function ownerUid(): bigint {
  if (typeof process.getuid !== "function") throw new InspectionFailure("verification-failed");
  return BigInt(process.getuid());
}

function stableScan(context: ScanContext): string {
  return JSON.stringify({
    findings: [...context.findings.entries()].sort(([left], [right]) => compareStrings(left, right)),
    snapshot: [...context.snapshot.entries()].sort(([left], [right]) => compareStrings(left, right)),
  });
}

function complete(findings: Map<string, HomeCredentialResidueFinding>): HomeCredentialResidueInspection {
  const rows = [...findings.values()].sort((left, right) => compareStrings(
    `${left.surface}\0${left.document}\0${left.variableName}`,
    `${right.surface}\0${right.document}\0${right.variableName}`,
  ));
  return Object.freeze({
    schema: HOME_CREDENTIAL_RESIDUE_SCHEMA,
    atRest: true,
    runtime: "unknown",
    state: rows.length === 0 ? "clean" : "residue",
    findings: Object.freeze(rows),
  });
}

function indeterminate(reason: "verification-failed" | "inventory-limit" | "changed"): HomeCredentialResidueInspection {
  return Object.freeze({
    schema: HOME_CREDENTIAL_RESIDUE_SCHEMA,
    atRest: true,
    runtime: "unknown",
    state: "indeterminate",
    findings: null,
    reason,
  });
}

class CleanupRefusal extends Error {
  readonly reason: NonNullable<HomeCredentialResidueCleanupResult["reason"]>;
  constructor(reason: NonNullable<HomeCredentialResidueCleanupResult["reason"]>) {
    super(reason);
    this.reason = reason;
  }
}

type LiveSelectionState = "complete" | "installation-only" | "absent" | "invalid";
type CleanupOperationOutcome =
  | Readonly<{ kind: "cleaned" }>
  | Readonly<{ kind: "cleaned-resume-unauthorized" }>
  | Readonly<{ kind: "failed" }>;

/**
 * Preview or irreversibly remove the one supported legacy plaintext slot.
 * Recovery phases, paths, and secret values remain hidden behind this Interface.
 */
export async function cleanupHomeCredentialResidue(input: Readonly<{
  vaultPath: string;
  authorization?: typeof HOME_CREDENTIAL_CLEANUP_AUTHORIZATION;
}>, deps: HomeCredentialResidueCleanupDeps = {}): Promise<HomeCredentialResidueCleanupResult> {
  if (input.authorization !== undefined && input.authorization !== HOME_CREDENTIAL_CLEANUP_AUTHORIZATION) {
    return cleanupResult("apply", "blocked", "indeterminate", "not-run", "authorization-required",
      "rerun-with-apply", 64,
      "Credential cleanup requires the exact destructive authorization.");
  }
  const vault = resolve(input.vaultPath);
  const preview = input.authorization === undefined;
  const initial = await inspectHomeCredentialResidue(vault, deps);
  if (initial.state === "indeterminate") {
    return cleanupResult(preview ? "preview" : "apply", "error", "indeterminate", "not-run",
      "verification-failed", "inspect-residue", 1,
      "Legacy credential residue could not be verified safely.");
  }
  if (initial.state === "clean") {
    const lifecycle = await (deps.inspectLifecycle ?? inspectHomeLifecycleSuspension)(vault);
    if (lifecycle.kind === "active" && lifecycle.suspension.purpose === "credential-cleanup") {
      if (preview) return cleanupResult("preview", "recovery-required", "clean", "recovery-required",
        "cleanup-incomplete", "retry-cleanup", 1,
        "Plaintext is clean, but an interrupted credential cleanup must resume or finish recovery.");
    } else if (preview) {
      return cleanupResult("preview", "clean", "clean", "not-run", null, "none", 0,
        "No legacy plaintext credential residue was found.");
    }
  }
  if (initial.state === "residue" && initial.findings.some((finding) => finding.variableName !== "ANTHROPIC_API_KEY")) {
    return cleanupResult(preview ? "preview" : "apply", "blocked", "residue", "not-run",
      "unsupported-residue", "inspect-residue", 64,
      "Unsupported secret-like residue must be handled manually before cleanup.");
  }
  if (preview) {
    return cleanupResult("preview", "residue", "residue", "not-run", "authorization-required",
      "rerun-with-apply", 1,
      "Legacy Anthropic plaintext residue is present; --apply irreversibly removes it and prunes contaminated terminal upgrade archives.");
  }

  const credentials = deps.credentials ?? openHomeCredentials();
  const resolveModel = deps.resolveModel ?? ((path: string) => resolveHomeModelRuntime(path, { credentials }));
  const readUpgrade = deps.readUpgrade ?? ((path: string) => readHomeUpgradeDisposition(path, deps));
  try {
    if (await readUpgrade(vault) !== null) throw new CleanupRefusal("recover-upgrade");
    const lifecycle = await (deps.inspectLifecycle ?? inspectHomeLifecycleSuspension)(vault);
    if (lifecycle.kind === "unavailable" || lifecycle.kind === "invalid") {
      throw new CleanupRefusal("lifecycle-busy");
    }
    if (lifecycle.kind === "active" && lifecycle.suspension.purpose !== "credential-cleanup") {
      throw new CleanupRefusal("lifecycle-busy");
    }
    if (initial.state === "clean" && lifecycle.kind === "inactive") {
      return cleanupResult("apply", "clean", "clean", "not-run", null, "none", 0,
        "No legacy plaintext credential residue was found.");
    }
    await requireReadyShippedModel(vault, resolveModel);
    const operationId = lifecycle.kind === "active"
      ? lifecycle.suspension.operationId
      : (deps.operationId ?? randomUUID)();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) {
      throw new Error("credential cleanup operation id is invalid");
    }
    const liveSelection = await classifyLiveSelection(vault, deps);
    if (liveSelection === "invalid") throw new CleanupRefusal("verification-failed");
    if (liveSelection === "installation-only" || liveSelection === "absent") {
      if (await serviceLoaded(vault, deps)) throw new CleanupRefusal("lifecycle-busy");
      const mutation = await (deps.mutateLifecycle ?? withHomeLifecycleMutation)(vault, async () => {
        await (deps.proveStopped ?? ((path: string) => assertHomeStoppedForLifecycleMutation(path, deps)))(vault);
        if (await classifyLiveSelection(vault, deps) !== liveSelection) {
          throw new Error("Home selection changed before credential cleanup acquired ownership");
        }
        const host = await withProductHostOwnership(vault, () =>
          cleanupWhileOwned(vault, operationId, resolveModel, deps, liveSelection));
        if (host.kind === "busy") throw new Error("Dome Home Product Host ownership is busy");
      });
      if (mutation.kind === "suspended") throw new CleanupRefusal("lifecycle-busy");
      return cleanupResult("apply", "cleaned", "clean", "stopped", null, "none", 0,
        "Legacy Anthropic plaintext residue was removed; Home remains stopped.");
    }
    const invocation = lifecycle.kind === "active"
      ? Object.freeze({ mode: "recover" as const, vaultPath: vault, purpose: "credential-cleanup" as const,
        operationId, policy: "retry-idempotent" as const })
      : Object.freeze({ mode: "new" as const, vaultPath: vault, purpose: "credential-cleanup" as const, operationId });
    const suspended = await (deps.suspend ?? withSupervisedHomeSuspended)(invocation, async (context): Promise<CleanupOperationOutcome> => {
      try {
        await cleanupWhileOwned(vault, operationId, resolveModel, deps, "complete");
      } catch {
        return Object.freeze({ kind: "failed" });
      }
      try {
        await context.authorizeCurrentHomeForResume();
        return Object.freeze({ kind: "cleaned" });
      } catch {
        return Object.freeze({ kind: "cleaned-resume-unauthorized" });
      }
    }, deps);
    return await completedSuspension(vault, suspended, deps);
  } catch (error) {
    const reason = error instanceof CleanupRefusal ? error.reason : "cleanup-incomplete";
    if (reason === "recover-upgrade") {
      return cleanupResult("apply", "blocked", await freshCleanupTruth(vault, deps), "not-run", reason, "recover-upgrade", 64,
        "Finish or recover the active Dome Home upgrade before credential cleanup.");
    }
    if (reason === "configure-shipped-model" || reason === "configure-keychain") {
      return cleanupResult("apply", "blocked", await freshCleanupTruth(vault, deps), "not-run", reason, "configure-model", 64,
        "Configure and verify the shipped Anthropic model credential before cleanup.");
    }
    if (reason === "lifecycle-busy") {
      return cleanupResult("apply", "blocked", await freshCleanupTruth(vault, deps), "not-run", reason, "retry-cleanup", 75,
        "Another Dome Home lifecycle operation owns the vault; retry cleanup later.");
    }
    if (reason === "unsupported-residue") {
      return cleanupResult("apply", "blocked", await freshCleanupTruth(vault, deps), "not-run", reason, "inspect-residue", 64,
        "Unsupported secret-like residue must be handled manually before cleanup.");
    }
    return await failedApplyResult(vault, deps);
  }
}

async function freshCleanupTruth(
  vault: string,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<HomeCredentialResidueCleanupResult["cleanup"]> {
  return (await inspectHomeCredentialResidue(vault, deps)).state;
}

async function cleanupWhileOwned(
  vault: string,
  operationId: string,
  resolveModel: (vaultPath: string) => Promise<HomeModelRuntime>,
  deps: HomeCredentialResidueCleanupDeps,
  liveSelection: Exclude<LiveSelectionState, "invalid">,
): Promise<void> {
  if (await (deps.readUpgrade ?? ((path: string) => readHomeUpgradeDisposition(path, deps)))(vault) !== null) {
    throw new CleanupRefusal("recover-upgrade");
  }
  const before = await inspectHomeCredentialResidue(vault, deps);
  requireSupportedInspection(before);
  await requireReadyShippedModel(vault, resolveModel);
  const paths = homeInstallationPaths(vault, deps);
  const global = await withManagedReleaseStoreCoordinator(paths.root, async (owner) => {
    if (liveSelection !== "absent") await sanitizeLiveSelection(vault, deps, liveSelection, owner);
    await removeTransientResidue(vault, operationId, deps);
    await removeContaminatedHistory(vault, operationId, deps);
  }, { waitMs: 30_000 });
  if (global.kind === "busy") throw new Error("managed Home store is busy");
  await deps.cleanupCheckpoint?.("before-final-inspection");
  await requireReadyShippedModel(vault, resolveModel);
  const after = await inspectHomeCredentialResidue(vault, deps);
  if (after.state !== "clean") throw new Error("credential residue remains after cleanup");
}

function requireSupportedInspection(inspection: HomeCredentialResidueInspection): void {
  if (inspection.state === "indeterminate") throw new Error("credential residue is indeterminate");
  if (inspection.state === "residue" &&
    inspection.findings.some((finding) => finding.variableName !== "ANTHROPIC_API_KEY")) {
    throw new CleanupRefusal("unsupported-residue");
  }
}

async function requireReadyShippedModel(
  vault: string,
  resolveModel: (vaultPath: string) => Promise<HomeModelRuntime>,
): Promise<void> {
  const model = await resolveModel(vault);
  if (model.configuration !== "shipped-anthropic") throw new CleanupRefusal("configure-shipped-model");
  if (model.credential !== "present" || model.modelState !== "ready") throw new CleanupRefusal("configure-keychain");
}

async function sanitizeLiveSelection(
  vault: string,
  deps: HomeCredentialResidueCleanupDeps,
  expected: "complete" | "installation-only",
  owner: ManagedReleaseStoreOwner,
): Promise<void> {
  if (await classifyLiveSelection(vault, deps) !== expected) {
    throw new Error("Home selection changed before credential cleanup mutation");
  }
  const record = await readHomeInstallation(vault, deps);
  if (record === null) throw new Error("Home installation is unavailable");
  const paths = homeInstallationPaths(vault, deps);
  const releasePath = releaseRoot(paths, record.artifact.id);
  const manifest = await (deps.verifyArtifact ?? verifyHomeArtifact)(releasePath);
  if (manifest.artifact.id !== record.artifact.id || manifest.product.version !== record.artifact.version) {
    throw new Error("selected Home release does not match the installation record");
  }
  await ensureManagedHomeRuntimeOwned(owner, {
    paths,
    artifactRoot: releasePath,
    manifest,
    platform: deps.platform ?? process.platform,
  }, deps);
  const environment = record.environment.filter((entry) => entry.name !== "ANTHROPIC_API_KEY");
  if (environment.some((entry) => isHomeSecretEnvironmentName(entry.name))) throw new CleanupRefusal("unsupported-residue");
  const desired = renderHomeSelection({
    vault,
    artifact: { id: record.artifact.id, version: record.artifact.version,
      releasePath, manifest },
    environment,
  }, deps);
  const current = await captureHomeSelectionDocument(paths.record, "legacy Home installation selector");
  if (current.sha256 !== desired.installation.sha256) {
    await publishHomeSelectionDocument({ expected: current, desired: desired.installation }, deps);
    await deps.cleanupCheckpoint?.("installation-published");
  }
  const plistPath = homeSelectionPaths(vault, deps).plist;
  if (!await pathExists(plistPath)) {
    if (expected === "complete") throw new Error("Home plist disappeared during credential cleanup");
    return;
  }
  const currentPlist = await captureHomeSelectionDocument(plistPath, "legacy Home LaunchAgent plist");
  if (currentPlist.sha256 !== desired.plist.sha256) {
    await publishHomeSelectionDocument({ expected: currentPlist, desired: desired.plist }, deps);
    await deps.cleanupCheckpoint?.("plist-published");
  }
  const finalInstallation = await captureHomeSelectionDocument(paths.record, "sanitized Home installation selector");
  const finalPlist = await captureHomeSelectionDocument(plistPath, "sanitized Home LaunchAgent plist");
  if (finalInstallation.sha256 !== desired.installation.sha256 || finalPlist.sha256 !== desired.plist.sha256) {
    throw new Error("sanitized Home selection did not converge to the verified release");
  }
}

async function removeTransientResidue(
  vault: string,
  operationId: string,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<void> {
  const installation = homeInstallationPaths(vault, deps).record;
  const plist = homeSelectionPaths(vault, deps).plist;
  for (const [parent, prefix, kind] of [
    [dirname(installation), `${basename(installation)}.tmp-`, "installation"],
    [dirname(plist), `${basename(plist)}.tmp-`, "plist"],
  ] as const) {
    if (!await pathExists(parent)) continue;
    const names = await readdir(parent);
    names.sort((left, right) => Number(!isFileCleanupTombstone(left, kind)) -
      Number(!isFileCleanupTombstone(right, kind)) || compareStrings(left, right));
    for (const name of names) {
      const ownTombstone = isFileCleanupTombstone(name, kind);
      if (!name.startsWith(prefix) && !ownTombstone) continue;
      const path = join(parent, name);
      if (!ownTombstone && !await documentHasAnthropic(path, kind, vault)) continue;
      await removeFileViaTombstone(path, join(parent, `.credential-cleanup-${operationId}-${kind}`), deps);
    }
  }
  const upgrade = join(dirname(installation), "upgrade");
  if (!await pathExists(upgrade)) return;
  const names = await readdir(upgrade);
  names.sort((left, right) => Number(!isStagingCleanupTombstone(left)) -
    Number(!isStagingCleanupTombstone(right)) || compareStrings(left, right));
  for (const name of names) {
    const own = isStagingCleanupTombstone(name);
    if (!name.startsWith(".staging-") && !own) continue;
    const root = join(upgrade, name);
    if (!own && !await directoryHasAnthropic(join(root, "selectors"), vault)) continue;
    const tombstone = own ? root : join(upgrade, `.credential-cleanup-${operationId}-staging-${name.slice(1)}`);
    await removeDirectoryViaTombstone(root, tombstone, "transient-renamed", deps);
  }
}

async function removeContaminatedHistory(
  vault: string,
  operationId: string,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<void> {
  const history = join(homeInstallationPaths(vault, deps).installations, "upgrade", "history");
  if (!await pathExists(history)) return;
  const names = await readdir(history);
  names.sort((left, right) => Number(!isHistoryCleanupTombstone(left)) -
    Number(!isHistoryCleanupTombstone(right)) || compareStrings(left, right));
  for (const name of names) {
    const own = isHistoryCleanupTombstone(name);
    if (own) {
      await removeDirectoryViaTombstone(join(history, name), join(history, name), "history-renamed", deps);
      continue;
    }
    const journal = await readHomeUpgradeHistory(vault, name, deps);
    if (journal?.selection === null || journal === null) continue;
    const root = join(history, name);
    if (!await directoryHasAnthropic(join(root, "selectors"), vault)) continue;
    await removeDirectoryViaTombstone(root,
      join(history, `.credential-cleanup-${operationId}-history-${name}`), "history-renamed", deps);
  }
}

function isFileCleanupTombstone(name: string, kind: "installation" | "plist"): boolean {
  return new RegExp(`^\\.credential-cleanup-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-${kind}$`).test(name);
}

function isStagingCleanupTombstone(name: string): boolean {
  return /^\.credential-cleanup-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-staging-[A-Za-z0-9._-]+$/.test(name);
}

function isHistoryCleanupTombstone(name: string): boolean {
  return /^\.credential-cleanup-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-history-[A-Za-z0-9._-]+$/.test(name);
}

async function directoryHasAnthropic(root: string, vault: string): Promise<boolean> {
  if (!await pathExists(root)) return false;
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || await realpath(root) !== resolve(root)) {
    throw new Error("credential residue directory is unsafe");
  }
  for (const name of await readdir(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) {
      if (await directoryHasAnthropic(path, vault)) return true;
    } else if (name.isFile()) {
      const kind = name.name.endsWith(".plist") ? "plist"
        : /^(?:old-|candidate-)?installation\.json$/.test(name.name) ? "installation" : null;
      if (kind !== null && await documentHasAnthropic(path, kind, vault)) return true;
    } else throw new Error("credential residue directory contains a redirected or special entry");
  }
  return false;
}

async function documentHasAnthropic(path: string, kind: "installation" | "plist", vault: string): Promise<boolean> {
  const captured = await captureHomeSelectionDocument(path, "legacy credential residue document");
  if (kind === "plist") return parsePlistEnvironmentNames(captured.bytes).includes("ANTHROPIC_API_KEY");
  let value: unknown;
  try { value = JSON.parse(captured.bytes); } catch { throw new Error("legacy installation residue is invalid"); }
  return parseHomeInstallationRecord(value, vault).environment.some((entry) => entry.name === "ANTHROPIC_API_KEY");
}

async function removeFileViaTombstone(
  source: string,
  tombstone: string,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<void> {
  if (source !== tombstone) {
    const before = await lstat(source, { bigint: true });
    await rename(source, tombstone);
    const after = await lstat(tombstone, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || after.isSymbolicLink()) {
      throw new Error("credential residue file changed across tombstone rename");
    }
    await syncDirectory(dirname(tombstone));
    await deps.cleanupCheckpoint?.("transient-renamed");
  }
  const direct = await lstat(tombstone);
  if (!direct.isFile() || direct.isSymbolicLink() || direct.nlink !== 1) throw new Error("credential residue tombstone is unsafe");
  await unlink(tombstone);
  await syncDirectory(dirname(tombstone));
}

async function removeDirectoryViaTombstone(
  source: string,
  tombstone: string,
  checkpoint: "transient-renamed" | "history-renamed",
  deps: HomeCredentialResidueCleanupDeps,
): Promise<void> {
  if (source !== tombstone) {
    const before = await lstat(source, { bigint: true });
    await rename(source, tombstone);
    const after = await lstat(tombstone, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || after.isSymbolicLink()) {
      throw new Error("credential residue directory changed across tombstone rename");
    }
    await syncDirectory(dirname(tombstone));
    await deps.cleanupCheckpoint?.(checkpoint);
  }
  const direct = await lstat(tombstone);
  if (!direct.isDirectory() || direct.isSymbolicLink() || await realpath(tombstone) !== resolve(tombstone)) {
    throw new Error("credential residue tombstone is unsafe");
  }
  await rm(tombstone, { recursive: true });
  await syncDirectory(dirname(tombstone));
}

async function classifyLiveSelection(
  vault: string,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<LiveSelectionState> {
  const installation = await pathExists(homeInstallationPaths(vault, deps).record);
  const plist = await pathExists(homeSelectionPaths(vault, deps).plist);
  if (installation && plist) return "complete";
  if (installation) return "installation-only";
  if (!plist) return "absent";
  return "invalid";
}

async function serviceLoaded(vault: string, deps: HomeCredentialResidueCleanupDeps): Promise<boolean> {
  if (deps.isServiceLoaded !== undefined) return await deps.isServiceLoaded(vault);
  const service = resolveServiceDeps(deps);
  if (service.platform !== "darwin" || service.uid === null) throw new Error("credential cleanup requires macOS launchd");
  return await probeLaunchAgentLoadedStrict({
    launchctl: service.launchctl,
    target: `gui/${service.uid}/com.dome.home.${vaultServiceSlug(vault)}`,
  });
}

async function completedSuspension(
  vault: string,
  result: SupervisedHomeSuspensionResult<CleanupOperationOutcome>,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<HomeCredentialResidueCleanupResult> {
  const after = await inspectHomeCredentialResidue(vault, deps);
  const cleanup = after.state;
  const home = result.kind === "ready" ? "ready" as const
    : result.kind === "not-required" ? "stopped" as const
    : "recovery-required" as const;
  const outcome = result.operationRan ? result.value : undefined;
  const cleanupSucceeded = outcome?.kind === "cleaned" || outcome?.kind === "cleaned-resume-unauthorized";

  if (result.kind === "failed" || result.kind === "deferred") {
    if (cleanupSucceeded && cleanup === "clean") {
      return cleanupResult("apply", "recovery-required", "clean", home, "resume-failed", "retry-cleanup", 1,
        "Plaintext cleanup completed, but Home resume requires retry.");
    }
    return cleanupResult("apply", "recovery-required", cleanup, home, "cleanup-incomplete", "retry-cleanup", 1,
      "Credential cleanup did not complete and the retained Home suspension requires retry.");
  }
  if (!result.operationRan) {
    if (cleanup === "clean") {
      return cleanupResult("apply", "clean", "clean", home, null, "none", 0,
        "Legacy plaintext is clean and Home lifecycle recovery completed.");
    }
    return cleanupResult("apply", "error", cleanup, home, "cleanup-incomplete", "retry-cleanup", 1,
      "Home lifecycle recovery completed without running credential cleanup; retry cleanup.");
  }
  if (outcome?.kind !== "cleaned" || cleanup !== "clean") {
    return cleanupResult("apply", "error", cleanup, home, "cleanup-incomplete", "retry-cleanup", 1,
      "Credential cleanup did not complete; Home returned to its prior service state.");
  }
  return cleanupResult("apply", "cleaned", "clean", home, null, "none", 0,
    home === "ready"
      ? "Legacy Anthropic plaintext residue was removed and Home resumed ready."
      : "Legacy Anthropic plaintext residue was removed; Home remains stopped.");
}

async function failedApplyResult(
  vault: string,
  deps: HomeCredentialResidueCleanupDeps,
): Promise<HomeCredentialResidueCleanupResult> {
  const [after, lifecycle] = await Promise.all([
    inspectHomeCredentialResidue(vault, deps),
    (deps.inspectLifecycle ?? inspectHomeLifecycleSuspension)(vault),
  ]);
  const retained = lifecycle.kind === "active" && lifecycle.suspension.purpose === "credential-cleanup";
  return cleanupResult("apply", retained ? "recovery-required" : "error", after.state,
    retained ? "recovery-required" : "not-run", "cleanup-incomplete", "retry-cleanup", 1,
    retained
      ? "Credential cleanup did not complete and the retained Home suspension requires retry."
      : "Credential cleanup could not start or complete safely; retry cleanup.");
}

function cleanupResult(
  mode: HomeCredentialResidueCleanupResult["mode"],
  status: HomeCredentialResidueCleanupResult["status"],
  cleanup: HomeCredentialResidueCleanupResult["cleanup"],
  home: HomeCredentialResidueCleanupResult["home"],
  reason: HomeCredentialResidueCleanupResult["reason"],
  nextAction: HomeCredentialResidueCleanupResult["nextAction"],
  exitCode: HomeCredentialResidueCleanupResult["exitCode"],
  message: string,
): HomeCredentialResidueCleanupResult {
  return Object.freeze({ schema: HOME_CREDENTIAL_CLEANUP_SCHEMA, mode, status, cleanup, home,
    reason, nextAction, message, exitCode });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Test seam for the common active/history selector scanner. */
export async function inspectStoredHomeCredentialResidueForTests(input: Readonly<{
  root: string;
  selection: HomeUpgradeSelectionEvidence;
  surface: "active" | "history";
  vault: string;
}>): Promise<HomeCredentialResidueInspection> {
  const context: ScanContext = { findings: new Map(), snapshot: new Map() };
  try {
    await scanStoredSelection(context, input.root, input.selection, input.surface, resolve(input.vault));
    return complete(context.findings);
  } catch (error) {
    return indeterminate(error instanceof InspectionFailure ? error.reason : "verification-failed");
  }
}
