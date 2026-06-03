// loader: walk a `bundlesRoot/` directory, parse each bundle's
// `manifest.yaml`, dynamic-import its processor modules, and return the
// flat list of `LoadedBundle`s.
//
// Per [[wiki/specs/sdk-surface]] §"Bundle load lifecycle", the loader's
// responsibility ends at producing the validated bundles + the bound
// processor objects. The downstream composer (`openVaultRuntime`) calls
// `buildRegistry(flattenBundleProcessors(bundles))` to build the
// engine-consumable `ProcessorRegistry` and threads the `extensions` /
// `processorVersions` lists into the projection-cache-key construction.
//
// Scope (Phase 8):
//   - Walks `bundlesRoot/` non-recursively; each immediate subdirectory is
//     a candidate bundle. Files in `bundlesRoot/` (not directories) are
//     ignored — a bundle root with mixed children is permitted (e.g.,
//     `assets/extensions/README.md` next to `assets/extensions/dome.lint/`).
//   - Reads `manifest.yaml` (or, fallback, `manifest.json`) from each
//     bundle directory. YAML is the spec default per
//     [[wiki/specs/sdk-surface]] §"`manifest.yaml` schema"; JSON support
//     exists for v1-era simplicity.
//   - Dynamic-imports each processor's `module:` path. The module's
//     default export must be a `ProcessorImplementation` (`{ run }`) or a
//     legacy full `Processor` whose manifest-owned metadata shape is complete
//     and whose (id, version, phase) matches the manifest declaration.
//     Manifest `module:` paths are confined to TypeScript files under
//     `<bundle>/processors/`; path escapes fail before import. A mismatch
//     fails the load with `processor-module-load-failed`.
//   - Returns `Result<ReadonlyArray<LoadedBundle>, LoadBundlesError>` —
//     never throws on expected I/O failures. Programmer errors (the bundle
//     directory layout itself is unreadable) propagate.
//
// Out of scope for Phase 8 (future polish):
//   - Cross-bundle dependency ordering. v1 manifests do not accept a `deps:`
//     field; bundles load in alphabetical-directory order within a root and
//     then in deterministic id order after root composition.
//   - Bundle install / scaffold logic — that's `dome init` (later phase).
//   - Scans `<bundle>/external-handlers/*.ts` and registers default-exported
//     handler functions by filename stem. Handler collision across the selected
//     bundle set fails before runtime open.
//   - Per-bundle preamble loading — Phase 9+ adds that. Bundle page types
//     are loaded today via `page-types.yaml`.
//
// House-style notes (matches src/engine/vault-runtime.ts, src/git.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Errors surface via `Result<T, E>`; never throws on expected I/O.
//   - Imports limited to v1 substrate + `node:fs/promises` + `node:path` +
//     the `yaml` package (already in package.json).

import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { err, ok, type Result } from "../types";
import type { Processor, ProcessorImplementation } from "../core/processor";
import type { ExternalHandler } from "../outbox/dispatch";
import {
  DEFAULT_PAGE_TYPE_DECLARATIONS,
  mergePageTypeDeclarations,
  parsePageTypesYaml,
  type PageTypeDeclaration,
  type PageTypeMergeError,
} from "../page-types";
import {
  parseManifest,
  type Manifest,
  type ManifestError,
  type ProcessorDeclaration,
} from "./manifest-schema";

// ----- Public types ---------------------------------------------------------

/**
 * A bundle that successfully loaded. `bundlePath` is the absolute path to
 * the bundle root (the parent directory of `manifest.yaml`); `processors`
 * is the imported, declared-and-bound processor list.
 */
export type LoadedBundle = {
  readonly id: string;
  readonly version: string;
  readonly processors: ReadonlyArray<Processor<unknown>>;
  readonly externalHandlers: ReadonlyMap<string, ExternalHandler>;
  readonly pageTypes: ReadonlyArray<PageTypeDeclaration>;
  readonly bundlePath: string;
};

export type BundleManifestSummary = {
  readonly id: string;
  readonly version: string;
  readonly processors: ReadonlyArray<ProcessorDeclaration>;
  readonly bundlePath: string;
};

/**
 * The closed set of `loadBundles` failures.
 *
 *   - `root-not-found`: `bundlesRoot` doesn't exist or isn't a directory.
 *   - `bundle-not-found`: the activation filter named one or more bundles
 *     that do not exist in the selected root set.
 *   - `manifest-read-failed`: a bundle's `manifest.{yaml,json}` was not
 *     readable (missing, permission denied, malformed YAML/JSON syntax).
 *   - `manifest-invalid`: the parsed payload failed `parseManifest` —
 *     either Zod shape rejection or phase × trigger matrix violation.
 *     Carries the nested `ManifestError` for the operator's error message.
 *   - `manifest-id-mismatch`: the bundle directory name and manifest `id`
 *     disagree. Bundle activation keys address directory names before
 *     import, so drift here must fail loudly.
 *   - `processor-module-load-failed`: a dynamic import threw, OR the
 *     imported module's default export had no `run`, had incomplete
 *     manifest-owned metadata, or its legacy full-Processor `(id, version,
 *     phase)` didn't match the manifest declaration. The `cause` field
 *     carries the thrown message (for import failures) or a structured
 *     mismatch string.
 *   - `processor-module-path-invalid`: a manifest `module:` path was
 *     absolute, escaped the bundle root, bypassed `processors/`, or did
 *     not point at a TypeScript module.
 *   - `processor-missing-default-export`: the imported module loaded but
 *     had no default export (or a non-object default).
 */
export type LoadBundlesError =
  | { readonly kind: "root-not-found"; readonly path: string }
  | {
      readonly kind: "bundle-not-found";
      readonly bundleIds: ReadonlyArray<string>;
      readonly bundlesRoots: ReadonlyArray<string>;
    }
  | {
      readonly kind: "manifest-read-failed";
      readonly bundleId: string;
      readonly cause: string;
    }
  | {
      readonly kind: "manifest-invalid";
      readonly bundleId: string;
      readonly cause: ManifestError;
    }
  | {
      readonly kind: "manifest-id-mismatch";
      readonly bundleDir: string;
      readonly manifestId: string;
    }
  | {
      readonly kind: "processor-module-load-failed";
      readonly bundleId: string;
      readonly modulePath: string;
      readonly cause: string;
    }
  | {
      readonly kind: "processor-module-path-invalid";
      readonly bundleId: string;
      readonly modulePath: string;
      readonly cause: string;
    }
  | {
      readonly kind: "processor-missing-default-export";
      readonly bundleId: string;
      readonly modulePath: string;
    }
  | {
      readonly kind: "external-handler-read-failed";
      readonly bundleId: string;
      readonly cause: string;
    }
  | {
      readonly kind: "external-handler-module-load-failed";
      readonly bundleId: string;
      readonly modulePath: string;
      readonly cause: string;
    }
  | {
      readonly kind: "external-handler-missing-default-export";
      readonly bundleId: string;
      readonly modulePath: string;
    }
  | {
      readonly kind: "external-handler-collision";
      readonly capability: string;
      readonly bundleIds: ReadonlyArray<string>;
    }
  | {
      readonly kind: "page-type-read-failed";
      readonly bundleId: string;
      readonly cause: string;
    }
  | {
      readonly kind: "page-type-invalid";
      readonly bundleId: string;
      readonly cause: string;
    }
  | {
      readonly kind: "page-type-collision";
      readonly cause: PageTypeMergeError;
    };

export type LoadBundlesOpts = {
  /**
   * Absolute (or process-relative) path to the directory containing one
   * subdirectory per bundle. Typical values are `<vault>/.dome/extensions/`
   * (for vault-installed bundles) or `assets/extensions/` (for SDK-shipped
   * first-party bundles during testing / dev).
   */
  readonly bundlesRoot: string;
  /**
   * Optional activation filter. When present, only bundle directories whose
   * directory name is in this set are read and imported. The runtime passes
   * this from `.dome/config.yaml` so disabled or omitted bundles do not get
   * dynamic-imported before the activation boundary.
   */
  readonly activeBundleIds?: ReadonlySet<string>;
};

export type LoadBundleRootsOpts = {
  /**
   * Ordered bundle roots. Later roots override earlier roots when they
   * provide the same bundle id, so vault-local bundles can replace shipped
   * first-party bundles without inventing a second extension mechanism.
   */
  readonly bundlesRoots: ReadonlyArray<string>;
  readonly activeBundleIds?: ReadonlySet<string>;
};

export type LoadBundleManifestSummaryFromRootsOpts = {
  readonly bundleId: string;
  readonly bundlesRoots: ReadonlyArray<string>;
};

// ----- loadBundles ----------------------------------------------------------

/**
 * Walk `bundlesRoot/`, load every immediate subdirectory's bundle, and
 * return the flat list. Bundles are loaded in alphabetical directory-name
 * order so cross-bundle behavior (e.g., page-type collision detection in a
 * future phase) is deterministic boot-to-boot.
 *
 * Fail-loud semantics: any single bundle failure aborts the load and
 * surfaces the corresponding `LoadBundlesError` variant; already-loaded
 * bundles in the same call are discarded (no partial-load state leaks
 * out). This matches the [[wiki/specs/sdk-surface]] §"Bundle-loader error
 * taxonomy" "fail-loud" mandate.
 */
export async function loadBundles(
  opts: LoadBundlesOpts,
): Promise<Result<ReadonlyArray<LoadedBundle>, LoadBundlesError>> {
  return loadBundlesInRoot({ ...opts, requireActiveBundleIds: true });
}

async function loadBundlesInRoot(
  opts: LoadBundlesOpts & { readonly requireActiveBundleIds: boolean },
): Promise<Result<ReadonlyArray<LoadedBundle>, LoadBundlesError>> {
  const rootAbs = resolve(opts.bundlesRoot);

  // 1. Stat the root. A missing / non-directory root is a hard failure —
  //    we don't silently return an empty list (that would mask a typo'd
  //    config path).
  try {
    const rootStat = await stat(rootAbs);
    if (!rootStat.isDirectory()) {
      return err({ kind: "root-not-found", path: rootAbs });
    }
  } catch {
    return err({ kind: "root-not-found", path: rootAbs });
  }

  // 2. Enumerate immediate children. `Dirent.isDirectory()` from
  //    `readdir({withFileTypes: true})` does NOT follow symlinks — a
  //    symlink-to-directory reports as `isSymbolicLink: true,
  //    isDirectory: false`. Real-world bundle installs may legitimately
  //    use symlinks (shared bundles across vaults, dev-mode
  //    symlinks into an SDK checkout), so we resolve each symlink via
  //    `stat()` (which DOES follow) and accept anything whose target
  //    is a directory.
  const entries = await readdir(rootAbs, { withFileTypes: true });
  const bundleDirs: string[] = [];
  for (const e of entries) {
    if (
      opts.activeBundleIds !== undefined &&
      !opts.activeBundleIds.has(e.name)
    ) {
      continue;
    }
    if (e.isDirectory()) {
      bundleDirs.push(e.name);
      continue;
    }
    if (e.isSymbolicLink()) {
      try {
        const targetStat = await stat(join(rootAbs, e.name));
        if (targetStat.isDirectory()) bundleDirs.push(e.name);
      } catch {
        // Broken symlink — skip silently. The loader is best-effort
        // on enumeration; a real-bundle-load failure surfaces at
        // manifest-read time with a structured error.
      }
    }
  }
  bundleDirs.sort();

  if (opts.requireActiveBundleIds && opts.activeBundleIds !== undefined) {
    const loadedIds = new Set(bundleDirs);
    const missing = [...opts.activeBundleIds]
      .filter((bundleId) => !loadedIds.has(bundleId))
      .sort();
    if (missing.length > 0) {
      return err({
        kind: "bundle-not-found",
        bundleIds: Object.freeze(missing),
        bundlesRoots: Object.freeze([rootAbs]),
      });
    }
  }

  // 3. Load each bundle in turn. First failure aborts.
  const loaded: LoadedBundle[] = [];
  for (const dirName of bundleDirs) {
    const bundlePath = join(rootAbs, dirName);
    const result = await loadOneBundle(bundlePath, dirName);
    if (!result.ok) return err(result.error);
    loaded.push(result.value);
  }

  const pageTypeCollisionCheck = mergePageTypeDeclarations(
    [
      ...DEFAULT_PAGE_TYPE_DECLARATIONS,
      ...loaded.flatMap((bundle) => [...bundle.pageTypes]),
    ],
    { enforceKnownTypes: true },
  );
  if (!pageTypeCollisionCheck.ok) {
    return err({
      kind: "page-type-collision",
      cause: pageTypeCollisionCheck.error,
    });
  }
  const externalHandlerCollisionCheck = detectExternalHandlerCollision(loaded);
  if (externalHandlerCollisionCheck !== null) {
    return err(externalHandlerCollisionCheck);
  }

  return ok(Object.freeze(loaded));
}

/**
 * Load and compose bundles from multiple roots. Each root is validated with
 * the same fail-loud semantics as `loadBundles`; duplicate bundle ids are
 * resolved by root order, with later roots replacing earlier bundles. The
 * composed bundle set is returned in deterministic bundle-id order.
 */
export async function loadBundlesFromRoots(
  opts: LoadBundleRootsOpts,
): Promise<Result<ReadonlyArray<LoadedBundle>, LoadBundlesError>> {
  const byId = new Map<string, LoadedBundle>();
  for (const bundlesRoot of opts.bundlesRoots) {
    const result = await loadBundlesInRoot({
      bundlesRoot,
      ...(opts.activeBundleIds !== undefined
        ? { activeBundleIds: opts.activeBundleIds }
        : {}),
      requireActiveBundleIds: false,
    });
    if (!result.ok) return err(result.error);
    for (const bundle of result.value) {
      byId.set(bundle.id, bundle);
    }
  }

  if (opts.activeBundleIds !== undefined) {
    const missing = [...opts.activeBundleIds]
      .filter((bundleId) => !byId.has(bundleId))
      .sort();
    if (missing.length > 0) {
      return err({
        kind: "bundle-not-found",
        bundleIds: Object.freeze(missing),
        bundlesRoots: Object.freeze(
          opts.bundlesRoots.map((root) => resolve(root)),
        ),
      });
    }
  }

  const loaded = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const pageTypeCollisionCheck = mergePageTypeDeclarations(
    [
      ...DEFAULT_PAGE_TYPE_DECLARATIONS,
      ...loaded.flatMap((bundle) => [...bundle.pageTypes]),
    ],
    { enforceKnownTypes: true },
  );
  if (!pageTypeCollisionCheck.ok) {
    return err({
      kind: "page-type-collision",
      cause: pageTypeCollisionCheck.error,
    });
  }
  const externalHandlerCollisionCheck = detectExternalHandlerCollision(loaded);
  if (externalHandlerCollisionCheck !== null) {
    return err(externalHandlerCollisionCheck);
  }
  return ok(Object.freeze(loaded));
}

/**
 * Read one bundle's validated manifest metadata from a composed root set
 * without importing processor modules or external handlers. Later roots have
 * precedence, matching `loadBundlesFromRoots`.
 */
export async function loadBundleManifestSummaryFromRoots(
  opts: LoadBundleManifestSummaryFromRootsOpts,
): Promise<Result<BundleManifestSummary | null, LoadBundlesError>> {
  for (const root of [...opts.bundlesRoots].reverse()) {
    const bundlePath = join(resolve(root), opts.bundleId);
    try {
      const bundleStat = await stat(bundlePath);
      if (!bundleStat.isDirectory()) continue;
    } catch {
      continue;
    }
    return readOneBundleManifestSummary(bundlePath, opts.bundleId);
  }
  return ok(null);
}

// ----- flattenBundleProcessors ----------------------------------------------

/**
 * Helper for the downstream composer: produce the flat
 * `ReadonlyArray<Processor>` the `buildRegistry` factory consumes. Kept
 * as a separate utility (rather than baked into `loadBundles`) so callers
 * can also operate on the per-bundle structure (e.g., to derive the
 * `extensions` / `processorVersions` lists for the projection cache key).
 */
export function flattenBundleProcessors(
  bundles: ReadonlyArray<LoadedBundle>,
): ReadonlyArray<Processor<unknown>> {
  const out: Processor<unknown>[] = [];
  for (const b of bundles) {
    for (const p of b.processors) out.push(p);
  }
  return Object.freeze(out);
}

// ----- internals ------------------------------------------------------------

/**
 * Load a single bundle: read + parse manifest, then dynamic-import each
 * declared processor module and bind it.
 *
 * `dirName` is passed in (rather than re-derived from `bundlePath`) so the
 * `manifest-read-failed` error carries a useful `bundleId` even when the
 * manifest itself was unreadable (in that case the manifest's declared `id`
 * is unknown; the directory name is the best stand-in).
 */
async function loadOneBundle(
  bundlePath: string,
  dirName: string,
): Promise<Result<LoadedBundle, LoadBundlesError>> {
  const manifestResult = await readOneBundleManifest(bundlePath, dirName);
  if (!manifestResult.ok) return err(manifestResult.error);
  const manifest: Manifest = manifestResult.value;
  const pageTypesResult = await readBundlePageTypes(bundlePath, manifest.id);
  if (!pageTypesResult.ok) {
    return err(pageTypesResult.error);
  }
  const pageTypes = pageTypesResult.value;

  // 3. For each declared processor, dynamic-import its module and bind.
  const processors: Processor<unknown>[] = [];
  for (const decl of manifest.processors) {
    const procResult = await loadProcessorModule(bundlePath, manifest.id, decl);
    if (!procResult.ok) return err(procResult.error);
    processors.push(procResult.value);
  }
  const externalHandlersResult = await loadExternalHandlers(
    bundlePath,
    manifest.id,
  );
  if (!externalHandlersResult.ok) return err(externalHandlersResult.error);

  return ok(
    Object.freeze({
      id: manifest.id,
      version: manifest.version,
      processors: Object.freeze(processors),
      externalHandlers: externalHandlersResult.value,
      pageTypes,
      bundlePath,
    }),
  );
}

async function readOneBundleManifestSummary(
  bundlePath: string,
  dirName: string,
): Promise<Result<BundleManifestSummary, LoadBundlesError>> {
  const manifestResult = await readOneBundleManifest(bundlePath, dirName);
  if (!manifestResult.ok) return err(manifestResult.error);
  const manifest = manifestResult.value;
  return ok(
    Object.freeze({
      id: manifest.id,
      version: manifest.version,
      processors: Object.freeze([...manifest.processors]),
      bundlePath,
    }),
  );
}

async function readOneBundleManifest(
  bundlePath: string,
  dirName: string,
): Promise<Result<Manifest, LoadBundlesError>> {
  // Try `manifest.yaml` first; fall back to `manifest.json` (some Phase 8
  // fixtures ship JSON to keep dev-friction low). Any read or parse failure
  // becomes `manifest-read-failed` with the failing path's tail in the cause
  // string.
  const manifestResult = await readBundleManifest(bundlePath);
  if (!manifestResult.ok) {
    return err({
      kind: "manifest-read-failed",
      bundleId: dirName,
      cause: manifestResult.error,
    });
  }

  // Validate the parsed payload. `parseManifest` runs the Zod shape check and
  // the phase × trigger matrix check.
  const parsed = parseManifest(manifestResult.value);
  if (!parsed.ok) {
    return err({
      kind: "manifest-invalid",
      bundleId: dirName,
      cause: parsed.error,
    });
  }
  const manifest: Manifest = parsed.value;
  if (manifest.id !== dirName) {
    return err({
      kind: "manifest-id-mismatch",
      bundleDir: dirName,
      manifestId: manifest.id,
    });
  }
  return ok(manifest);
}

/**
 * Read the bundle's manifest file. Prefers `manifest.yaml`; falls back to
 * `manifest.json`. Returns the parsed object on success, or a cause string
 * on read / parse failure.
 *
 * The fallback is intentional: YAML is the spec default but JSON ships as
 * a lower-friction option for tests and SDK-internal fixtures. The two
 * are mutually exclusive — a bundle with both files uses `manifest.yaml`.
 */
async function readBundleManifest(
  bundlePath: string,
): Promise<Result<unknown, string>> {
  const yamlPath = join(bundlePath, "manifest.yaml");
  const jsonPath = join(bundlePath, "manifest.json");

  // Try YAML first.
  const yamlText = await tryReadFile(yamlPath);
  if (yamlText.ok) {
    try {
      const parsed: unknown = parseYaml(yamlText.value);
      return ok(parsed);
    } catch (e) {
      return err(`manifest.yaml parse error: ${stringifyCause(e)}`);
    }
  }

  // Fall back to JSON.
  const jsonText = await tryReadFile(jsonPath);
  if (jsonText.ok) {
    try {
      const parsed: unknown = JSON.parse(jsonText.value);
      return ok(parsed);
    } catch (e) {
      return err(`manifest.json parse error: ${stringifyCause(e)}`);
    }
  }

  return err(
    `neither manifest.yaml nor manifest.json found in ${bundlePath}`,
  );
}

async function readBundlePageTypes(
  bundlePath: string,
  bundleId: string,
): Promise<Result<ReadonlyArray<PageTypeDeclaration>, LoadBundlesError>> {
  const path = join(bundlePath, "page-types.yaml");
  const text = await tryReadFile(path);
  if (!text.ok) {
    if (/ENOENT|no such file/i.test(text.error)) {
      return ok(Object.freeze([]));
    }
    return err({
      kind: "page-type-read-failed",
      bundleId,
      cause: text.error,
    });
  }
  const parsed = parsePageTypesYaml(text.value, `bundle:${bundleId}`);
  if (!parsed.ok) {
    return err({
      kind: "page-type-invalid",
      bundleId,
      cause: parsed.error.message,
    });
  }
  return ok(parsed.value);
}

/** Best-effort file read. Returns the contents on success, or err with a cause. */
async function tryReadFile(p: string): Promise<Result<string, string>> {
  try {
    const text = await readFile(p, "utf8");
    return ok(text);
  } catch (e) {
    return err(stringifyCause(e));
  }
}

/**
 * Dynamic-import a processor module and bind it to its manifest declaration.
 *
 * The import URL is built from `pathToFileURL(absoluteModulePath)` so the
 * dynamic import is unambiguous regardless of platform (Windows path
 * handling is bun-supported but the explicit `file://` URL is robust to
 * future shells / runners).
 *
 * New modules should export a `ProcessorImplementation` (`{ run }`) and keep
 * all static metadata in the manifest. Legacy full Processor exports remain
 * supported; when a module exports any manifest-owned metadata, it must be a
 * complete legacy shape and its id/version/phase values must match the
 * manifest so stale bundles fail loudly instead of running under surprising
 * names.
 */
async function loadProcessorModule(
  bundlePath: string,
  bundleId: string,
  decl: ProcessorDeclaration,
): Promise<Result<Processor<unknown>, LoadBundlesError>> {
  const modulePath = resolveProcessorModulePath(bundlePath, bundleId, decl);
  if (!modulePath.ok) return err(modulePath.error);
  const moduleAbs = modulePath.value;
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(moduleAbs).href)) as {
      default?: unknown;
    };
  } catch (e) {
    return err({
      kind: "processor-module-load-failed",
      bundleId,
      modulePath: decl.module,
      cause: stringifyCause(e),
    });
  }

  const defaultExport = mod.default;
  if (
    defaultExport === undefined ||
    defaultExport === null ||
    typeof defaultExport !== "object"
  ) {
    return err({
      kind: "processor-missing-default-export",
      bundleId,
      modulePath: decl.module,
    });
  }

  const implementation =
    defaultExport as Partial<ProcessorImplementation<unknown>>;
  if (typeof implementation.run !== "function") {
    return err({
      kind: "processor-module-load-failed",
      bundleId,
      modulePath: decl.module,
      cause: `manifest declared processor '${decl.id}'; module default export has no run function`,
    });
  }

  const mismatch = checkProcessorMetadataBoundary(decl, defaultExport);
  if (mismatch !== null) {
    return err({
      kind: "processor-module-load-failed",
      bundleId,
      modulePath: decl.module,
      cause: mismatch,
    });
  }

  return ok(
    bindProcessorDeclaration(
      decl,
      implementation as ProcessorImplementation<unknown>,
    ),
  );
}

function resolveProcessorModulePath(
  bundlePath: string,
  bundleId: string,
  decl: ProcessorDeclaration,
): Result<string, LoadBundlesError> {
  if (isAbsolute(decl.module)) {
    return err({
      kind: "processor-module-path-invalid",
      bundleId,
      modulePath: decl.module,
      cause: "module path must be relative to the bundle root",
    });
  }

  const moduleAbs = resolve(bundlePath, decl.module);
  if (!isWithin(bundlePath, moduleAbs)) {
    return err({
      kind: "processor-module-path-invalid",
      bundleId,
      modulePath: decl.module,
      cause: "module path must not escape the bundle root",
    });
  }

  const processorsRoot = resolve(bundlePath, "processors");
  if (!isWithin(processorsRoot, moduleAbs)) {
    return err({
      kind: "processor-module-path-invalid",
      bundleId,
      modulePath: decl.module,
      cause: "module path must live under processors/",
    });
  }

  if (!moduleAbs.endsWith(".ts")) {
    return err({
      kind: "processor-module-path-invalid",
      bundleId,
      modulePath: decl.module,
      cause: "module path must point at a .ts file",
    });
  }

  return ok(moduleAbs);
}

async function loadExternalHandlers(
  bundlePath: string,
  bundleId: string,
): Promise<Result<ReadonlyMap<string, ExternalHandler>, LoadBundlesError>> {
  const handlersRoot = join(bundlePath, "external-handlers");
  let entries: Dirent[];
  try {
    entries = await readdir(handlersRoot, { withFileTypes: true });
  } catch (e) {
    if (isMissingPathError(e)) return ok(new Map());
    return err({
      kind: "external-handler-read-failed",
      bundleId,
      cause: stringifyCause(e),
    });
  }

  const moduleFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    if (entry.isFile()) {
      moduleFiles.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        const targetStat = await stat(join(handlersRoot, entry.name));
        if (targetStat.isFile()) moduleFiles.push(entry.name);
      } catch {
        // Broken symlink — skip silently during enumeration.
      }
    }
  }
  moduleFiles.sort();

  const handlers = new Map<string, ExternalHandler>();
  for (const moduleFile of moduleFiles) {
    const capability = moduleFile.slice(0, -".ts".length);
    const modulePath = join("external-handlers", moduleFile);
    const moduleAbs = join(handlersRoot, moduleFile);
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(moduleAbs).href)) as {
        default?: unknown;
      };
    } catch (e) {
      return err({
        kind: "external-handler-module-load-failed",
        bundleId,
        modulePath,
        cause: stringifyCause(e),
      });
    }
    if (typeof mod.default !== "function") {
      return err({
        kind: "external-handler-missing-default-export",
        bundleId,
        modulePath,
      });
    }
    handlers.set(capability, mod.default as ExternalHandler);
  }

  return ok(handlers);
}

function detectExternalHandlerCollision(
  bundles: ReadonlyArray<LoadedBundle>,
): Extract<
  LoadBundlesError,
  { readonly kind: "external-handler-collision" }
> | null {
  const byCapability = new Map<string, string[]>();
  for (const bundle of bundles) {
    for (const capability of bundle.externalHandlers.keys()) {
      const bundleIds = byCapability.get(capability);
      if (bundleIds === undefined) {
        byCapability.set(capability, [bundle.id]);
      } else {
        bundleIds.push(bundle.id);
      }
    }
  }
  for (const [capability, bundleIds] of byCapability) {
    if (bundleIds.length > 1) {
      return {
        kind: "external-handler-collision",
        capability,
        bundleIds: Object.freeze([...bundleIds]),
      };
    }
  }
  return null;
}

function isWithin(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Verify manifest-owned metadata stays on one side of the boundary.
 * Implementation-only exports intentionally carry no static metadata. Legacy
 * full-Processor exports may carry metadata, but then the identity fields must
 * be present and agree with the manifest. Partial hybrid shapes fail loudly
 * rather than silently ignoring stale triggers/capabilities/execution fields.
 */
function checkProcessorMetadataBoundary(
  decl: ProcessorDeclaration,
  exported: object,
): string | null {
  const processor = exported as Partial<Processor<unknown>>;
  const metadataKeys = manifestMetadataKeys(exported);
  if (metadataKeys.length === 0) return null;
  if (
    !hasOwn(exported, "id") ||
    !hasOwn(exported, "version") ||
    !hasOwn(exported, "phase")
  ) {
    return `manifest declared processor '${decl.id}'; module exported manifest-owned metadata (${metadataKeys.join(", ")}) without complete legacy identity fields`;
  }
  if (processor.id !== decl.id) {
    return `manifest declared id '${decl.id}'; module exported id '${processor.id}'`;
  }
  if (processor.version !== decl.version) {
    return `manifest declared version '${decl.version}' for processor '${decl.id}'; module exported version '${processor.version}'`;
  }
  if (processor.phase !== decl.phase) {
    return `manifest declared phase '${decl.phase}' for processor '${decl.id}'; module exported phase '${processor.phase}'`;
  }
  const mismatchedField = firstMismatchedManifestField(decl, processor);
  if (mismatchedField !== null) {
    return `manifest declared processor '${decl.id}'; module exported stale manifest-owned field '${mismatchedField}'`;
  }
  return null;
}

function firstMismatchedManifestField(
  decl: ProcessorDeclaration,
  processor: Partial<Processor<unknown>>,
): string | null {
  const checks: ReadonlyArray<
    readonly [keyof Processor<unknown>, unknown, unknown]
  > = [
    ["triggers", processor.triggers, decl.triggers],
    ["capabilities", processor.capabilities, decl.capabilities],
    ["execution", processor.execution, decl.execution],
    ["inspection", processor.inspection, decl.inspection],
  ];
  for (const [field, exportedValue, manifestValue] of checks) {
    if (
      exportedValue !== undefined &&
      stableJson(exportedValue) !== stableJson(manifestValue)
    ) {
      return field;
    }
  }
  return null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (
      inner !== null &&
      typeof inner === "object" &&
      !Array.isArray(inner)
    ) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return inner;
  });
}

function manifestMetadataKeys(exported: object): ReadonlyArray<string> {
  const keys = [
    "id",
    "version",
    "phase",
    "triggers",
    "capabilities",
    "execution",
    "inspection",
  ];
  return keys.filter((key) => hasOwn(exported, key));
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Bind manifest-reviewed metadata onto the executable processor. This keeps
 * the manifest as the reviewable source of truth for triggers, capabilities,
 * and execution policy, while preserving the module's `run` implementation.
 */
function bindProcessorDeclaration(
  decl: ProcessorDeclaration,
  implementation: ProcessorImplementation<unknown>,
): Processor<unknown> {
  const base = {
    id: decl.id,
    version: decl.version,
    phase: decl.phase,
    triggers: Object.freeze([...decl.triggers]),
    capabilities: Object.freeze([...decl.capabilities]),
    run: implementation.run,
    ...(decl.inspection !== undefined
      ? { inspection: Object.freeze({ ...decl.inspection }) }
      : {}),
  } satisfies Omit<Processor<unknown>, "execution">;

  if (decl.execution === undefined) {
    return Object.freeze(base);
  }

  return Object.freeze({
    ...base,
    execution: Object.freeze({ ...decl.execution }),
  });
}

/**
 * Coerce a caught `unknown` into a string for error-cause fields. `Error`
 * instances surface their `.message`; everything else stringifies through
 * `String(...)`. Centralized so the loader's error payloads are uniform.
 */
function stringifyCause(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isMissingPathError(e: unknown): boolean {
  return e instanceof Error && /\bENOENT\b|no such file/i.test(e.message);
}
