// product-host/home-artifact: the shipped, strict trust boundary for a Dome
// Home artifact. The build script and installed lifecycle intentionally share
// this verifier so an artifact is never admitted under weaker runtime rules.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareStrings } from "../core/compare";

export const HOME_ARTIFACT_SCHEMA = "dome.home-artifact/v1" as const;
export const HOME_ARTIFACT_TARGET = Object.freeze({ os: "darwin", arch: "arm64" });
export const PINNED_BUN_VERSION = "1.2.13";
export const PINNED_BUN_ARCHIVE_URL =
  "https://github.com/oven-sh/bun/releases/download/bun-v1.2.13/bun-darwin-aarch64.zip";
export const PINNED_BUN_ARCHIVE_SHA256 = "8154367524d8c298edb269b8d0df61d469ec4194d361c07e4b8d2c65fbbc2efb";
export const PINNED_BUN_BINARY_SHA256 = "c059443bc18f61b17609d1c3c7ae3fa7d8e2c121921732baf2b71964c7142f6c";
export const PINNED_AGE_VERSION = "1.3.1";
export const PINNED_AGE_ARCHIVE_URL =
  "https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-darwin-arm64.tar.gz";
export const PINNED_AGE_ARCHIVE_SHA256 = "01120ea2cbf0463d4c6bd767f99f3271bbed1cdc8a9aa718a76ba1fe4f01998b";
export const PINNED_AGE_BINARY_SHA256 = "0e3ea0b1bed2b30aa2dc46eef4e1723864d626c80f37319c20d9b73ca045f56f";
export const PINNED_AGE_KEYGEN_BINARY_SHA256 = "37c4b509d86f233d8dd065f5a905e11d2e1d5549d59445a9bc52da9235a622ad";
export const PINNED_AGE_LICENSE_SHA256 = "afbdb4e07a359499db587ae632815809b1fc1670a92d5449af112ce9a67833a2";

export type HomeArtifactManifest = {
  readonly schema: typeof HOME_ARTIFACT_SCHEMA;
  readonly product: { readonly name: "Dome Home"; readonly version: string };
  readonly target: typeof HOME_ARTIFACT_TARGET;
  readonly build: { readonly gitCommit: string };
  readonly artifact: { readonly id: string };
  readonly runtime: {
    readonly name: "bun";
    readonly version: string;
    readonly sourceUrl: string;
    readonly archiveSha256: string;
    readonly sha256: string;
  };
  readonly tools: ReadonlyArray<{
    readonly name: "age" | "age-keygen";
    readonly version: string;
    readonly path: "runtime/age" | "runtime/age-keygen";
    readonly sourceUrl: string;
    readonly archiveSha256: string;
    readonly sha256: string;
    readonly licensePath: "licenses/age-LICENSE";
    readonly licenseSha256: string;
  }>;
  readonly entrypoint: "bin/dome";
  readonly pwa: "app/pwa/dist";
  readonly distribution: {
    readonly signed: false;
    readonly notarized: false;
    readonly upgradeSupported: false;
  };
  readonly entries: ReadonlyArray<HomeArtifactEntry>;
};

export type HomeArtifactEntry =
  | { readonly type: "file"; readonly path: string; readonly bytes: number; readonly sha256: string; readonly mode: string }
  | { readonly type: "directory"; readonly path: string; readonly mode: string }
  | { readonly type: "symlink"; readonly path: string; readonly target: string; readonly targetSha256: string };

export type HomeArtifactVerifier = (artifactRoot: string) => Promise<HomeArtifactManifest>;

export async function verifyHomeArtifact(artifactRootInput: string): Promise<HomeArtifactManifest> {
  const artifactRoot = resolve(artifactRootInput);
  const manifestPath = join(artifactRoot, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size > 16 * 1024 * 1024) {
    throw new Error("artifact manifest is missing, not a file, or exceeds its size budget");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { throw new Error(`artifact manifest is invalid at ${manifestPath}`); }
  const manifest = parseManifest(decoded);

  const actualEntries = await inventoryEntriesWithoutMetadata(artifactRoot);
  const expectedShape = manifest.entries.map((entry) => `${entry.path}\0${entry.type}`).sort();
  const actualShape = actualEntries.map((entry) => `${entry.path}\0${entry.type}`).sort();
  if (JSON.stringify(actualShape) !== JSON.stringify(expectedShape)) {
    throw new Error("artifact entry path/type set differs from its manifest");
  }
  for (const entry of manifest.entries) {
    const absolute = join(artifactRoot, entry.path);
    const info = await lstat(absolute);
    if (entry.type === "symlink") {
      const target = await readlink(absolute);
      if (target !== entry.target || sha256(Buffer.from(target)) !== entry.targetSha256) {
        throw new Error(`artifact symlink target mismatch: ${entry.path}`);
      }
      continue;
    }
    if (entry.type === "file" && (info.size !== entry.bytes || sha256(await readFile(absolute)) !== entry.sha256)) {
      throw new Error(`artifact checksum mismatch: ${entry.path}`);
    }
    if (mode(info.mode) !== entry.mode) throw new Error(`artifact mode mismatch: ${entry.path}`);
  }
  if (manifest.artifact.id !== sha256(Buffer.from(JSON.stringify(manifest.entries)))) {
    throw new Error("artifact identity does not match its payload");
  }
  const runtimeEntry = manifest.entries.find((entry) => entry.type === "file" && entry.path === "runtime/bun");
  if (runtimeEntry?.type !== "file" || runtimeEntry.sha256 !== manifest.runtime.sha256) {
    throw new Error("artifact runtime checksum is missing or inconsistent");
  }
  const expectedChecksums = [
    ...manifest.entries.filter((entry): entry is Extract<HomeArtifactEntry, { type: "file" }> => entry.type === "file")
      .map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(await readFile(manifestPath))}  manifest.json`,
  ].sort((left, right) => compareStrings(left.slice(66), right.slice(66))).join("\n") + "\n";
  if (await readFile(join(artifactRoot, "checksums.sha256"), "utf8") !== expectedChecksums) {
    throw new Error("artifact checksums.sha256 is incomplete or inconsistent");
  }
  for (const path of await archiveEntries(artifactRoot)) {
    const absolute = join(artifactRoot, path);
    if (!(await lstat(absolute)).isSymbolicLink()) continue;
    const target = resolve(dirname(absolute), await readlink(absolute));
    const relativeTarget = relative(artifactRoot, target);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || target === artifactRoot) {
      throw new Error(`artifact symlink escapes its root: ${path}`);
    }
    if (!existsSync(target)) throw new Error(`artifact contains broken symlink: ${path}`);
  }
  const entrypointInfo = await lstat(join(artifactRoot, manifest.entrypoint));
  if (!entrypointInfo.isFile() || (entrypointInfo.mode & 0o111) === 0) {
    throw new Error("artifact entrypoint is missing or not executable");
  }
  if (!(await lstat(join(artifactRoot, manifest.pwa, "index.html"))).isFile()) {
    throw new Error("artifact PWA index is missing");
  }
  const pinnedTools = [
    { name: "age", path: "runtime/age", sha256: PINNED_AGE_BINARY_SHA256 },
    { name: "age-keygen", path: "runtime/age-keygen", sha256: PINNED_AGE_KEYGEN_BINARY_SHA256 },
  ] as const;
  for (const pinned of pinnedTools) {
    const tool = manifest.tools.find((candidate) => candidate.name === pinned.name);
    if (tool === undefined || tool.version !== PINNED_AGE_VERSION || tool.path !== pinned.path ||
      tool.sourceUrl !== PINNED_AGE_ARCHIVE_URL || tool.archiveSha256 !== PINNED_AGE_ARCHIVE_SHA256 ||
      tool.sha256 !== pinned.sha256 || tool.licensePath !== "licenses/age-LICENSE" ||
      tool.licenseSha256 !== PINNED_AGE_LICENSE_SHA256) {
      throw new Error(`artifact ${pinned.name} provenance is not the pinned official age release`);
    }
    const entry = manifest.entries.find((candidate) => candidate.type === "file" && candidate.path === tool.path);
    if (entry?.type !== "file" || entry.sha256 !== tool.sha256) {
      throw new Error(`artifact ${pinned.name} checksum is missing or inconsistent`);
    }
    const license = manifest.entries.find((candidate) => candidate.type === "file" && candidate.path === tool.licensePath);
    if (license?.type !== "file" || license.sha256 !== tool.licenseSha256) {
      throw new Error("artifact age license checksum is missing or inconsistent");
    }
  }
  if (manifest.runtime.sha256 !== PINNED_BUN_BINARY_SHA256) {
    throw new Error("artifact runtime binary is not the pinned official Bun build");
  }
  const runtimeVersion = (await runVersion(join(artifactRoot, "runtime", "bun"), artifactRoot)).trim();
  if (runtimeVersion !== PINNED_BUN_VERSION) throw new Error(`artifact runtime reports ${runtimeVersion}`);
  for (const tool of manifest.tools) {
    const reported = (await runVersion(join(artifactRoot, tool.path), artifactRoot)).trim();
    if (reported !== `v${PINNED_AGE_VERSION}`) throw new Error(`artifact ${tool.name} reports ${reported}`);
  }
  return manifest;
}

function parseManifest(value: unknown): HomeArtifactManifest {
  const root = record(value, "artifact manifest", ["schema", "product", "target", "build", "artifact", "runtime", "tools", "entrypoint", "pwa", "distribution", "entries"]);
  if (root["schema"] !== HOME_ARTIFACT_SCHEMA) throw new Error(`unsupported artifact schema: ${String(root["schema"])}`);
  const product = record(root["product"], "artifact product", ["name", "version"]);
  const target = record(root["target"], "artifact target", ["os", "arch"]);
  const build = record(root["build"], "artifact build", ["gitCommit"]);
  const artifact = record(root["artifact"], "artifact identity", ["id"]);
  const runtime = record(root["runtime"], "artifact runtime", ["name", "version", "sourceUrl", "archiveSha256", "sha256"]);
  const distribution = record(root["distribution"], "artifact distribution", ["signed", "notarized", "upgradeSupported"]);
  if (product["name"] !== "Dome Home" || !nonempty(product["version"]) ||
    target["os"] !== HOME_ARTIFACT_TARGET.os || target["arch"] !== HOME_ARTIFACT_TARGET.arch ||
    !fullObjectId(build["gitCommit"]) || !sha(artifact["id"]) ||
    runtime["name"] !== "bun" || runtime["version"] !== PINNED_BUN_VERSION ||
    runtime["sourceUrl"] !== PINNED_BUN_ARCHIVE_URL || runtime["archiveSha256"] !== PINNED_BUN_ARCHIVE_SHA256 || !sha(runtime["sha256"]) ||
    root["entrypoint"] !== "bin/dome" || root["pwa"] !== "app/pwa/dist" ||
    distribution["signed"] !== false || distribution["notarized"] !== false || distribution["upgradeSupported"] !== false) {
    throw new Error("artifact manifest fixed product semantics are invalid");
  }
  if (!Array.isArray(root["entries"]) || root["entries"].length === 0) throw new Error("artifact entries must be a non-empty array");
  const entries = root["entries"].map(parseEntry);
  const keys = entries.map((entry) => `${entry.path}\0${entry.type}`);
  if (new Set(keys).size !== keys.length || entries.some((entry, index) => index > 0 && compareStrings(entries[index - 1]!.path, entry.path) >= 0)) {
    throw new Error("artifact entries must have unique, strictly sorted paths");
  }
  if (!Array.isArray(root["tools"]) || root["tools"].length !== 2) throw new Error("artifact must include the pinned age toolchain");
  const tools = root["tools"].map((candidate) => {
    const tool = record(candidate, "artifact tool", ["name", "version", "path", "sourceUrl", "archiveSha256", "sha256", "licensePath", "licenseSha256"]);
    if ((tool["name"] !== "age" && tool["name"] !== "age-keygen") || !nonempty(tool["version"]) ||
      (tool["path"] !== "runtime/age" && tool["path"] !== "runtime/age-keygen") || !nonempty(tool["sourceUrl"]) ||
      !sha(tool["archiveSha256"]) || !sha(tool["sha256"]) || tool["licensePath"] !== "licenses/age-LICENSE" || !sha(tool["licenseSha256"])) {
      throw new Error("artifact tool entry is invalid");
    }
    return tool as HomeArtifactManifest["tools"][number];
  });
  if (new Set(tools.map((tool) => tool.name)).size !== 2) throw new Error("artifact tool names must be unique");
  return root as unknown as HomeArtifactManifest;
}

function parseEntry(value: unknown): HomeArtifactEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("artifact entry must be an object");
  const type = (value as Record<string, unknown>)["type"];
  const keys = type === "file" ? ["type", "path", "bytes", "sha256", "mode"] :
    type === "directory" ? ["type", "path", "mode"] : type === "symlink" ? ["type", "path", "target", "targetSha256"] : [];
  if (keys.length === 0) throw new Error("artifact entry type is invalid");
  const entry = record(value, "artifact entry", keys);
  if (!safeRelativePath(entry["path"])) throw new Error("artifact entry path is unsafe");
  if (type === "file" && (!Number.isSafeInteger(entry["bytes"]) || (entry["bytes"] as number) < 0 || !sha(entry["sha256"]) || !modeString(entry["mode"]))) throw new Error("artifact file entry is invalid");
  if (type === "directory" && !modeString(entry["mode"])) throw new Error("artifact directory entry is invalid");
  if (type === "symlink" && (typeof entry["target"] !== "string" || !sha(entry["targetSha256"]))) throw new Error("artifact symlink entry is invalid");
  return entry as unknown as HomeArtifactEntry;
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.startsWith("/") &&
    !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }
function fullObjectId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value); }
function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function modeString(value: unknown): value is string { return typeof value === "string" && /^0[0-7]{3}$/.test(value); }
function mode(value: number): string { return (value & 0o777).toString(8).padStart(4, "0"); }
function sha256(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }

async function inventoryEntriesWithoutMetadata(root: string): Promise<HomeArtifactEntry[]> {
  const found: HomeArtifactEntry[] = [];
  for (const path of await archiveEntries(root)) {
    if (path === "manifest.json" || path === "checksums.sha256") continue;
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isDirectory()) found.push({ type: "directory", path, mode: mode(info.mode) });
    else if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      found.push({ type: "symlink", path, target, targetSha256: sha256(Buffer.from(target)) });
    } else if (info.isFile()) found.push({ type: "file", path, bytes: info.size, sha256: sha256(await readFile(absolute)), mode: mode(info.mode) });
    else throw new Error(`artifact contains unsupported entry: ${path}`);
  }
  return found;
}

async function archiveEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      found.push(path);
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return found.sort(compareStrings);
}

async function runVersion(program: string, cwd: string): Promise<string> {
  const child = Bun.spawn([program, "--version"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${program} --version failed (${exitCode}): ${stderr.trim()}`);
  return stdout;
}
