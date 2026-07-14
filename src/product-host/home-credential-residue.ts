// Read-only, path-free discovery of legacy at-rest credential persistence for
// one Dome Home vault. Runtime process state is deliberately out of scope.

import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { compareStrings } from "../core/compare";
import { homeInstallationPaths, parseHomeInstallationRecord, type HomeInstallationDeps } from "./home-installation";
import { captureHomeSelectionDocument, homeSelectionPaths, type HomeSelectionDeps } from "./home-selection";
import {
  readHomeUpgrade,
  readHomeUpgradeHistory,
  type HomeUpgradeSelectionEvidence,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";
import { isHomeSecretEnvironmentName } from "./home-credentials";
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
  if (liveInstallation !== livePlist) throw new InspectionFailure("verification-failed");
  if (liveInstallation) {
    await scanInstallation(context, paths.record, vault, "live");
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
    for (const name of names.filter((name) => name.startsWith(`${basename(installationPath)}.tmp-`))) {
      await scanInstallation(context, join(installationParent, name), vault, "transient");
    }
  }
  const plistParent = dirname(plistPath);
  if (await present(context, plistParent)) {
    const names = await boundedNames(context, plistParent, null);
    for (const name of names.filter((name) => name.startsWith(`${basename(plistPath)}.tmp-`))) {
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
  const plist = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\n<plist version="1\.0">\n<dict>\n  <key>Label<\/key>\n  <string>([^<]*)<\/string>\n  <key>ProgramArguments<\/key>\n  <array>\n((?:    <string>[^<]*<\/string>\n)+)  <\/array>\n  <key>EnvironmentVariables<\/key>\n  <dict>\n((?:    <key>[^<]*<\/key>\n    <string>[^<]*<\/string>\n)*)  <\/dict>\n  <key>WorkingDirectory<\/key>\n  <string>([^<]*)<\/string>\n  <key>RunAtLoad<\/key>\n  <true\/>\n  <key>KeepAlive<\/key>\n  <true\/>\n  <key>StandardOutPath<\/key>\n  <string>([^<]*)<\/string>\n  <key>StandardErrorPath<\/key>\n  <string>([^<]*)<\/string>\n<\/dict>\n<\/plist>\n$/.exec(bytes);
  if (plist === null) throw new InspectionFailure("verification-failed");
  decodeXml(plist[1]!);
  for (const argument of plist[2]!.matchAll(/    <string>([^<]*)<\/string>\n/g)) decodeXml(argument[1]!);
  decodeXml(plist[4]!);
  const stdout = decodeXml(plist[5]!);
  if (decodeXml(plist[6]!) !== stdout) throw new InspectionFailure("verification-failed");
  const body = plist[3]!;
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
