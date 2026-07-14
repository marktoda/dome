// product-host/home-selection: exact two-file Home release selection.
//
// installation.json is the authoritative selector and the LaunchAgent plist
// is its executable projection.  Upgrade recovery must reason about the pair
// without teaching the transaction journal how either document is rendered.

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compareStrings } from "../core/compare";
import { renderLaunchAgentPlist } from "../platform/launchd";
import { publishPathExclusive } from "../platform/exclusive-rename";
import { vaultServiceSlug } from "../surface/service-probe";
import {
  HOME_INSTALLATION_SCHEMA,
  homeInstallationPaths,
  releaseRoot,
  type HomeInstallationDeps,
  type HomeInstallationRecord,
} from "./home-installation";

const HOME_HOST = "127.0.0.1";
const HOME_PORT = 3663;

export type HomeSelectionDeps = Pick<HomeInstallationDeps, "applicationSupportDir"> & {
  readonly launchAgentsDir?: string | undefined;
  readonly beforeRename?: ((expected: HomeSelectionDocument, desired: HomeSelectionDocument) => Promise<void>) | undefined;
  readonly renamePath?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly publishMissingPath?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly syncParent?: ((path: string) => Promise<void>) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
};

export type HomeSelectionDocument = {
  readonly path: string;
  readonly bytes: string;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
};

export type HomeSelection = {
  readonly installation: HomeSelectionDocument;
  readonly plist: HomeSelectionDocument;
};

export type HomeSelectionState = "old" | "candidate" | "mixed" | "invalid";

export function homeSelectionPaths(vault: string, deps: HomeSelectionDeps = {}): {
  readonly installation: string;
  readonly plist: string;
} {
  const canonical = resolve(vault);
  const installation = homeInstallationPaths(canonical, deps).record;
  const launchAgents = resolve(
    deps.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents"),
  );
  const label = `com.dome.home.${vaultServiceSlug(canonical)}`;
  return Object.freeze({
    installation,
    plist: join(launchAgents, `${label}.plist`),
  });
}

/** Render the complete candidate selector pair from one verified artifact. */
export function renderHomeSelection(input: {
  readonly vault: string;
  readonly artifact: { readonly id: string; readonly version: string; readonly releasePath: string };
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}, deps: HomeSelectionDeps = {}): HomeSelection {
  const vault = resolve(input.vault);
  if (!/^[a-f0-9]{64}$/.test(input.artifact.id)) {
    throw new Error("Home selection artifact id is invalid");
  }
  const expectedRelease = releaseRoot(homeInstallationPaths(vault, deps), input.artifact.id);
  if (input.artifact.releasePath !== expectedRelease) {
    throw new Error("Home selection release path is not the canonical content-addressed release");
  }
  if (input.artifact.version.length === 0 || input.artifact.version.length > 1024) {
    throw new Error("Home selection artifact version is invalid");
  }
  const environment = [...input.environment]
    .sort((left, right) => compareStrings(left.name, right.name));
  if (environment.some((entry, index) =>
    entry.name.length === 0 || entry.name.includes("=") || entry.name.includes("\0") ||
    entry.value.includes("\0") ||
    (index > 0 && environment[index - 1]!.name === entry.name))) {
    throw new Error("Home selection environment is invalid");
  }
  const record: HomeInstallationRecord = Object.freeze({
    schema: HOME_INSTALLATION_SCHEMA,
    vault,
    artifact: Object.freeze({ id: input.artifact.id, version: input.artifact.version }),
    environment: Object.freeze(environment.map((entry) => Object.freeze({ ...entry }))),
  });
  const installationBytes = `${JSON.stringify(record, null, 2)}\n`;
  const paths = homeSelectionPaths(vault, deps);
  const label = `com.dome.home.${vaultServiceSlug(vault)}`;
  const runtime = join(input.artifact.releasePath, "runtime", "bun");
  const launchEnvironment = new Map(environment.map((entry) => [entry.name, entry.value]));
  launchEnvironment.set("PATH", homeServicePath(runtime));
  const plistBytes = renderLaunchAgentPlist({
    label,
    programArguments: [
      runtime,
      join(input.artifact.releasePath, "app", "bin", "dome"),
      "home", "--vault", vault,
      "--host", HOME_HOST,
      "--port", String(HOME_PORT),
      "--static-dir", join(input.artifact.releasePath, "app", "pwa", "dist"),
    ],
    workingDirectory: vault,
    logPath: join(vault, ".dome", "state", "home.log"),
    environment: launchEnvironment,
  });
  return Object.freeze({
    installation: selectionDocument(paths.installation, installationBytes, 0o600),
    plist: selectionDocument(paths.plist, plistBytes, 0o600),
  });
}

/** Capture exact existing selector bytes without interpreting their contents. */
export async function captureHomeSelection(
  vault: string,
  deps: HomeSelectionDeps = {},
): Promise<HomeSelection> {
  const paths = homeSelectionPaths(vault, deps);
  return Object.freeze({
    installation: await captureHomeSelectionDocument(paths.installation, "installation selector"),
    plist: await captureHomeSelectionDocument(paths.plist, "LaunchAgent plist"),
  });
}

/** Classify the live pair. Invalid includes missing, redirected, or altered bytes. */
export async function classifyHomeSelection(input: {
  readonly old: HomeSelection;
  readonly candidate: HomeSelection;
}): Promise<HomeSelectionState> {
  const installation = await classifyDocument(input.old.installation, input.candidate.installation);
  const plist = await classifyDocument(input.old.plist, input.candidate.plist);
  if (installation === "invalid" || plist === "invalid") return "invalid";
  if (installation === plist) return installation;
  return "mixed";
}

/** Atomically replace one selector document and fsync its parent. */
export async function publishHomeSelectionDocument(
  input: {
    readonly expected: HomeSelectionDocument;
    readonly desired: HomeSelectionDocument;
  },
  deps: HomeSelectionDeps = {},
): Promise<void> {
  assertDocumentEvidence(input.expected);
  assertDocumentEvidence(input.desired);
  if (input.expected.path !== input.desired.path) {
    throw new Error("Home selection CAS paths differ");
  }
  const parentPath = dirname(input.desired.path);
  if (await realpath(parentPath) !== parentPath) {
    throw new Error("Home selection parent is redirected");
  }
  await assertCurrentDocument(input.expected);
  const temporary = `${input.desired.path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", input.desired.mode);
  try {
    await handle.writeFile(input.desired.bytes, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await deps.beforeRename?.(input.expected, input.desired);
    // This is the final expected-byte check before the one atomic replacement.
    // External actors do not share a lock, so the interface makes the CAS
    // expectation explicit and verifies desired bytes again after publication.
    await assertCurrentDocument(input.expected);
    await (deps.renamePath ?? rename)(temporary, input.desired.path);
    await (deps.syncParent ?? syncDirectory)(dirname(input.desired.path));
    await assertCurrentDocument(input.desired);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * Converge the journal-owned candidate pair, plist first. Missing paths use
 * no-replace publication; bounded direct files use stable-handle CAS. Both
 * paths are inspected before the first write so redirected/special evidence
 * cannot leave a predictable partial repair.
 */
export async function repairHomeSelection(
  desired: HomeSelection,
  deps: HomeSelectionDeps = {},
  checkpoint?: ((name: "plist-published" | "installation-published") => Promise<void>) | undefined,
): Promise<void> {
  await inspectRepairableDocument(desired.plist.path);
  await inspectRepairableDocument(desired.installation.path);
  await convergeRepairDocument(desired.plist, deps);
  await checkpoint?.("plist-published");
  await convergeRepairDocument(desired.installation, deps);
  await checkpoint?.("installation-published");
}

async function convergeRepairDocument(
  desired: HomeSelectionDocument,
  deps: HomeSelectionDeps,
): Promise<void> {
  const current = await inspectRepairableDocument(desired.path);
  if (current !== null) {
    if (sameDocument(current, desired)) {
      await syncAndVerifyRepairDocument(desired, deps);
      return;
    }
    await publishHomeSelectionDocument({ expected: current, desired }, deps);
    return;
  }
  assertDocumentEvidence(desired);
  const parentPath = dirname(desired.path);
  if (await realpath(parentPath) !== parentPath) throw new Error("Home selection parent is redirected");
  const temporary = `${desired.path}.repair-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", desired.mode);
  try {
    await handle.writeFile(desired.bytes, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    try {
      await (deps.publishMissingPath ?? (async (source, target) => publishPathExclusive({
        source,
        target,
        ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      })))(temporary, desired.path);
    } catch (error) {
      const winner = await inspectRepairableDocument(desired.path);
      if (winner === null || !sameDocument(winner, desired)) throw error;
      await syncAndVerifyRepairDocument(desired, deps);
      return;
    }
    await syncAndVerifyRepairDocument(desired, deps);
  } finally { await rm(temporary, { force: true }); }
}

async function syncAndVerifyRepairDocument(
  desired: HomeSelectionDocument,
  deps: HomeSelectionDeps,
): Promise<void> {
  const parentPath = dirname(desired.path);
  if (await realpath(parentPath) !== parentPath) throw new Error("Home selection parent is redirected");
  await (deps.syncParent ?? syncDirectory)(parentPath);
  const durable = await inspectRepairableDocument(desired.path);
  if (durable === null || !sameDocument(durable, desired)) {
    throw new Error("repaired Home selector does not match committed evidence");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const parent = await open(path, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

async function inspectRepairableDocument(path: string): Promise<HomeSelectionDocument | null> {
  try { return await captureHomeSelectionDocument(path, "Home selector repair target"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function selectionDocument(
  path: string,
  bytes: string,
  mode: number,
): HomeSelectionDocument {
  if (path !== resolve(path) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error("Home selection document evidence is invalid");
  }
  const body = Buffer.from(bytes, "utf8");
  return Object.freeze({
    path,
    bytes,
    mode,
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}

function assertDocumentEvidence(document: HomeSelectionDocument): void {
  const recomputed = selectionDocument(document.path, document.bytes, document.mode);
  if (recomputed.size !== document.size || recomputed.sha256 !== document.sha256) {
    throw new Error("Home selection document evidence does not match its bytes");
  }
}

export async function captureHomeSelectionDocument(
  path: string,
  label = "Home selector",
): Promise<HomeSelectionDocument> {
  // lstat is diagnostic only. O_NOFOLLOW plus before/after fstat makes the
  // opened inode—not a raced path lookup—the evidence being hashed.
  const pathInfo = await lstat(path);
  if (pathInfo.isSymbolicLink()) throw new Error(`${label} is redirected`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertCapturable(before, label);
    const bytes = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    assertCapturable(after, label);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while it was captured`);
    }
    return selectionDocument(path, bytes, before.mode & 0o777);
  } finally { await handle.close(); }
}

function assertCapturable(info: Stats, label: string): void {
  if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) {
    throw new Error(`${label} is not a bounded direct regular file`);
  }
}

async function assertCurrentDocument(expected: HomeSelectionDocument): Promise<void> {
  const current = await captureHomeSelectionDocument(expected.path, "existing Home selector");
  if (!sameDocument(current, expected)) {
    throw new Error("Home selection CAS expected bytes changed");
  }
}

async function classifyDocument(
  old: HomeSelectionDocument,
  candidate: HomeSelectionDocument,
): Promise<"old" | "candidate" | "invalid"> {
  if (old.path !== candidate.path) return "invalid";
  let current: HomeSelectionDocument;
  try { current = await captureHomeSelectionDocument(old.path, "Home selector"); }
  catch { return "invalid"; }
  if (sameDocument(current, old)) return "old";
  if (sameDocument(current, candidate)) return "candidate";
  return "invalid";
}

function sameDocument(left: HomeSelectionDocument, right: HomeSelectionDocument): boolean {
  return left.path === right.path && left.mode === right.mode && left.size === right.size &&
    left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function homeServicePath(runtimePath: string): string {
  return [
    dirname(runtimePath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin",
    "/bin", "/usr/sbin", "/sbin",
  ].filter((value, index, all) => all.indexOf(value) === index).join(":");
}
