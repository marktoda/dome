// product-host/home-selection: exact two-file Home release selection.
//
// installation.json is the authoritative selector and the LaunchAgent plist
// is its executable projection.  Upgrade recovery must reason about the pair
// without teaching the transaction journal how either document is rendered.

import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compareStrings } from "../core/compare";
import { renderLaunchAgentPlist } from "../platform/launchd";
import { vaultServiceSlug } from "../surface/service-probe";
import {
  HOME_INSTALLATION_SCHEMA,
  homeInstallationPaths,
  type HomeInstallationDeps,
  type HomeInstallationRecord,
} from "./home-installation";

const HOME_HOST = "127.0.0.1";
const HOME_PORT = 3663;

export type HomeSelectionDeps = Pick<HomeInstallationDeps, "applicationSupportDir"> & {
  readonly launchAgentsDir?: string | undefined;
  readonly publishFile?: ((path: string, bytes: string) => Promise<void>) | undefined;
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
  if (input.artifact.releasePath !== resolve(input.artifact.releasePath)) {
    throw new Error("Home selection release path is not canonical");
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
    installation: await captureDocument(paths.installation, "installation selector"),
    plist: await captureDocument(paths.plist, "LaunchAgent plist"),
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
  document: HomeSelectionDocument,
  deps: HomeSelectionDeps = {},
): Promise<void> {
  if (deps.publishFile !== undefined) return deps.publishFile(document.path, document.bytes);
  const temporary = `${document.path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", document.mode);
  try {
    await handle.writeFile(document.bytes, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await rename(temporary, document.path);
    const parent = await open(dirname(document.path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
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

async function captureDocument(path: string, label: string): Promise<HomeSelectionDocument> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) {
    throw new Error(`${label} is not a bounded direct regular file`);
  }
  return selectionDocument(path, await readFile(path, "utf8"), info.mode & 0o777);
}

async function classifyDocument(
  old: HomeSelectionDocument,
  candidate: HomeSelectionDocument,
): Promise<"old" | "candidate" | "invalid"> {
  if (old.path !== candidate.path) return "invalid";
  let current: HomeSelectionDocument;
  try { current = await captureDocument(old.path, "Home selector"); }
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
