import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, type Result, type ToolError } from "../types";
import { parseManifest, type Manifest } from "./manifest-schema";

/**
 * A loaded extension bundle's metadata. Paths are absolute; missing optional
 * contributions (no page-types.yaml, no preamble.md, etc.) are represented
 * by null for single-file contributions and empty arrays for directory
 * contributions.
 */
export interface ExtensionBundle {
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly directory: string;
  readonly manifestPath: string;
  readonly pageTypesPath: string | null;
  readonly preamblePath: string | null;
  readonly workflowPaths: readonly string[];
  readonly hookPaths: readonly string[];
  readonly cliPaths: readonly string[];
  readonly toolPaths: readonly string[];
}

/**
 * Walk <vault>/.dome/extensions/<bundle>/ and load every bundle's manifest +
 * contribution paths. Bundles load alphabetically by directory name. Returns
 * Result.err on the first bundle-load-failure (fail-loud per
 * docs/wiki/gotchas/extension-bundle-load-order.md).
 *
 * v0.5 contract: returns metadata only (paths). Page-types merge, hook
 * registration, workflow loading, CLI registration are downstream consumers'
 * responsibility (loadVaultConfig, loadDeclarativeHooks, PromptLoader, runCli).
 */
export async function loadExtensionBundles(
  vaultRoot: string,
): Promise<Result<readonly ExtensionBundle[], ToolError>> {
  const extensionsDir = join(vaultRoot, ".dome", "extensions");
  if (!existsSync(extensionsDir)) return ok([]);

  let dirEntries: { name: string; isDirectory: () => boolean }[];
  try {
    dirEntries = await readdir(extensionsDir, { withFileTypes: true });
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-missing",
      message: `cannot read .dome/extensions/: ${String(e)}`,
    });
  }

  const dirs = dirEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const bundles: ExtensionBundle[] = [];
  for (const name of dirs) {
    const bundle = await loadOneBundle(extensionsDir, name);
    if (!bundle.ok) return bundle;
    bundles.push(bundle.value);
  }
  return ok(bundles);
}

async function loadOneBundle(
  extensionsDir: string,
  bundleName: string,
): Promise<Result<ExtensionBundle, ToolError>> {
  const directory = join(extensionsDir, bundleName);
  const manifestPath = join(directory, "manifest.yaml");

  if (!existsSync(manifestPath)) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-missing",
      message: `bundle '${bundleName}' has no manifest.yaml at ${manifestPath}`,
    });
  }

  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-invalid",
      message: `bundle '${bundleName}': cannot read manifest.yaml: ${String(e)}`,
    });
  }

  const manifestResult = parseManifest(manifestText, `${bundleName}/manifest.yaml`);
  if (!manifestResult.ok) return manifestResult as Result<never, ToolError>;
  const manifest: Manifest = manifestResult.value;

  if (manifest.name !== bundleName) {
    return err({
      kind: "bundle-load-failure",
      detail: "name-mismatch",
      message: `bundle directory '${bundleName}' contains manifest.yaml with name: '${manifest.name}'; the two must match`,
    });
  }

  const pageTypesPath = await maybeFile(directory, "page-types.yaml");
  const preamblePath = await maybeFile(directory, "preamble.md");
  const workflowPaths = await listFilesIn(directory, "workflows", ".md");
  const hookPaths = await listFilesIn(directory, "hooks", ".yaml", ".yml");
  const cliPaths = await listFilesIn(directory, "cli", ".ts");
  const toolPaths = await listFilesIn(directory, "tools", ".ts");

  return ok({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    directory,
    manifestPath,
    pageTypesPath,
    preamblePath,
    workflowPaths,
    hookPaths,
    cliPaths,
    toolPaths,
  });
}

async function maybeFile(dir: string, name: string): Promise<string | null> {
  const candidate = join(dir, name);
  if (!existsSync(candidate)) return null;
  try {
    const s = await stat(candidate);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

async function listFilesIn(
  dir: string,
  subdir: string,
  ...extensions: string[]
): Promise<readonly string[]> {
  const subPath = join(dir, subdir);
  if (!existsSync(subPath)) return [];
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = await readdir(subPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .sort()
    .map((name) => join(subPath, name));
}
