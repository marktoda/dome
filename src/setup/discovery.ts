import { arch, platform } from "node:os";
import { resolve } from "node:path";

import type { ContentScopeConfig } from "../core/content-scope";
import { verifyHomeArtifactEvidence } from "../product-host/home-artifact";
import {
  homeInstallationPaths,
  parseHomeInstallationRecord,
  releaseRoot,
} from "../product-host/home-installation";
import {
  captureHomeSelectionDocument,
  type HomeSelectionDocument,
} from "../product-host/home-selection";
import { inspectHomeUpgradeStatus } from "../product-host/home-upgrade-status";
import {
  verifyInstalledProductReadOnly,
  type ReadOnlyInstalledProductEvidence,
} from "../product-package/installed-product";
import type {
  SetupCompilerInput,
  SetupInstalledHomeEvidence,
  SetupObservedPrerequisites,
  SetupProductEvidence,
  SetupScaffoldEvidence,
} from "./compiler";
import { inspectSetupVaultSource } from "./vault-inspector";

export type SetupDiscoveryDeps = Readonly<{
  packageRoot?: string | undefined;
  inspectSource?: typeof inspectSetupVaultSource | undefined;
  discoverPrerequisites?: (() => Promise<SetupObservedPrerequisites>) | undefined;
  discoverProduct?: ((packageRoot: string) => Promise<SetupProductEvidence>) | undefined;
  discoverInstalledHome?: ((targetPath: string) => Promise<SetupInstalledHomeEvidence>) | undefined;
  contentScope?: ContentScopeConfig | undefined;
  scaffold?: SetupScaffoldEvidence | undefined;
}>;

type SetupInstalledHomeOperations = Readonly<{
  captureSelection: typeof captureHomeSelectionDocument;
  inspectUpgrade: typeof inspectHomeUpgradeStatus;
  verifyArtifact: typeof verifyHomeArtifactEvidence;
}>;

export type SetupInstalledHomeDiscoveryDeps = Readonly<{
  applicationSupportDir?: string | undefined;
  operations?: Partial<SetupInstalledHomeOperations> | undefined;
}>;

/** One bounded, read-only adapter. It never opens a vault runtime or service. */
export async function discoverSetupCompilerInput(
  targetInput: string,
  deps: SetupDiscoveryDeps = {},
): Promise<SetupCompilerInput> {
  const targetPath = resolve(targetInput);
  const packageRoot = resolve(deps.packageRoot ?? resolve(import.meta.dir, "../.."));
  if (deps.contentScope === undefined || deps.scaffold === undefined) {
    throw new Error("setup discovery requires injected content-scope and scaffold evidence");
  }
  const [source, prerequisites, product, installedHome] = await Promise.all([
    (deps.inspectSource ?? inspectSetupVaultSource)(targetPath),
    (deps.discoverPrerequisites ?? discoverSetupPrerequisites)(),
    (deps.discoverProduct ?? discoverSetupProduct)(packageRoot),
    (deps.discoverInstalledHome ?? discoverSetupInstalledHome)(targetPath),
  ]);
  return Object.freeze({
    source,
    host: Object.freeze({ platform: platform(), architecture: arch() }),
    prerequisites,
    product,
    installedHome,
    contentScope: deps.contentScope,
    scaffold: deps.scaffold,
  });
}

export async function discoverSetupPrerequisites(): Promise<SetupObservedPrerequisites> {
  return Object.freeze({ bun: normalizeVersion(Bun.version), git: await discoverGitVersion() });
}

export async function discoverSetupProduct(
  packageRoot: string,
  verify: typeof verifyInstalledProductReadOnly = verifyInstalledProductReadOnly,
): Promise<SetupProductEvidence> {
  const evidence: ReadOnlyInstalledProductEvidence = await verify({ packageRoot: resolve(packageRoot) });
  const manifest = evidence.manifest;
  return Object.freeze({
    packageName: manifest.package.name,
    packageVersion: manifest.package.version,
    sourceCommit: manifest.package.sourceCommit,
    productManifestSha256: evidence.manifestSha256,
    packagedHome: Object.freeze({
      artifactId: evidence.declaredHome.artifactId,
      productVersion: manifest.home.productVersion,
      buildCommit: evidence.declaredHome.buildCommit,
      manifestSha256: evidence.declaredHome.manifestSha256,
    }),
  });
}

export async function discoverSetupInstalledHome(
  targetInput: string,
  deps: SetupInstalledHomeDiscoveryDeps = {},
): Promise<SetupInstalledHomeEvidence> {
  const targetPath = resolve(targetInput);
  const paths = homeInstallationPaths(targetPath, deps);
  const operations: SetupInstalledHomeOperations = {
    captureSelection: deps.operations?.captureSelection ?? captureHomeSelectionDocument,
    inspectUpgrade: deps.operations?.inspectUpgrade ?? inspectHomeUpgradeStatus,
    verifyArtifact: deps.operations?.verifyArtifact ?? verifyHomeArtifactEvidence,
  };
  let selected: HomeSelectionDocument;
  try { selected = await operations.captureSelection(paths.record, "Dome Home installation selector"); }
  catch (error) { return hasCode(error, "ENOENT") ? emptyHome("absent") : emptyHome("ambiguous"); }
  let installation;
  try {
    const decoded: unknown = JSON.parse(selected.bytes);
    const selectedVault = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) &&
      typeof (decoded as Record<string, unknown>)["vault"] === "string"
      ? resolve((decoded as Record<string, string>)["vault"]!)
      : targetPath;
    installation = parseHomeInstallationRecord(decoded, selectedVault);
  }
  catch { return emptyHome("ambiguous"); }
  if (installation.vault !== targetPath) {
    try {
      const finalSelection = await operations.captureSelection(paths.record, "Dome Home installation selector");
      if (!sameSelectionDocument(selected, finalSelection)) return emptyHome("ambiguous");
    } catch { return emptyHome("ambiguous"); }
    return Object.freeze({
      state: "foreign-owner" as const,
      artifactId: installation.artifact.id,
      productVersion: installation.artifact.version,
      buildCommit: null,
      manifestSha256: null,
      selectedVaultPath: installation.vault,
    });
  }
  // Upgrade status canonicalizes an existing selected vault. Check it only
  // after durable installation evidence exists so a genuinely new path does
  // not become "unavailable" merely because realpath cannot resolve it.
  const upgrade = await operations.inspectUpgrade(targetPath, {
    ...(deps.applicationSupportDir === undefined ? {} : { applicationSupportDir: deps.applicationSupportDir }),
  });
  if (upgrade.state === "active" || upgrade.state === "recovery-required") return emptyHome("upgrade-active");
  if (upgrade.state === "unavailable") return emptyHome("ambiguous");
  try {
    const evidence = await operations.verifyArtifact(releaseRoot(paths, installation.artifact.id));
    const manifest = evidence.manifest;
    if (manifest.artifact.id !== installation.artifact.id || manifest.product.version !== installation.artifact.version) {
      return emptyHome("ambiguous");
    }
    const finalSelection = await operations.captureSelection(paths.record, "Dome Home installation selector");
    if (!sameSelectionDocument(selected, finalSelection)) return emptyHome("ambiguous");
    return Object.freeze({
      state: "owned" as const,
      artifactId: manifest.artifact.id,
      productVersion: manifest.product.version,
      buildCommit: manifest.build.gitCommit,
      manifestSha256: evidence.manifestSha256,
      selectedVaultPath: installation.vault,
    });
  } catch {
    return emptyHome("ambiguous");
  }
}

function sameSelectionDocument(left: HomeSelectionDocument, right: HomeSelectionDocument): boolean {
  return left.path === right.path && left.bytes === right.bytes && left.mode === right.mode &&
    left.size === right.size && left.sha256 === right.sha256;
}

export async function discoverGitVersion(options: Readonly<{
  command?: ReadonlyArray<string>;
  timeoutMs?: number;
}> = {}): Promise<string | null> {
  const command = options.command ?? ["git", "--version"];
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (command.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("git --version probe configuration is invalid");
  }
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...command], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.all([
    collectBounded(child.stdout, 1024, "git --version stdout"),
    collectBounded(child.stderr, 1024, "git --version stderr"),
    child.exited,
  ]);
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`git --version timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const [stdoutBytes, stderrBytes, exitCode] = await Promise.race([settled, timeout]);
    const stdout = stdoutBytes.toString("utf8");
    const stderr = stderrBytes.toString("utf8");
    if (exitCode === 127) return null;
    if (exitCode !== 0) throw new Error(`git --version failed: ${stderr.trim() || `exit ${exitCode}`}`);
    const match = /^git version ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(stdout.trim());
    if (match?.[1] === undefined) throw new Error("git --version output is invalid");
    return normalizeVersion(match[1]);
  } catch (error) {
    try { await terminate(child); }
    catch (terminationError) {
      throw new AggregateError([error, terminationError], "git --version probe and termination both failed");
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emptyHome(state: "absent" | "upgrade-active" | "ambiguous"): SetupInstalledHomeEvidence {
  return Object.freeze({
    state,
    artifactId: null,
    productVersion: null,
    buildCommit: null,
    manifestSha256: null,
    selectedVaultPath: null,
  });
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, "");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  label: string,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error(`${label} exceeded ${maximum} bytes`);
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

async function terminate(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  try { child.kill("SIGTERM"); } catch {}
  if (await settles(child.exited, 250)) return;
  try { child.kill("SIGKILL"); } catch {}
  if (!await settles(child.exited, 1_000)) throw new Error("git --version process did not exit after SIGKILL");
}

async function settles(promise: Promise<number>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}
