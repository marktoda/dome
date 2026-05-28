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
//     default export must be a `Processor` whose (id, version, phase)
//     matches the manifest declaration. A mismatch fails the load with
//     `processor-module-load-failed`.
//   - Returns `Result<ReadonlyArray<LoadedBundle>, LoadBundlesError>` —
//     never throws on expected I/O failures. Programmer errors (the bundle
//     directory layout itself is unreadable) propagate.
//
// Out of scope for Phase 8 (future polish):
//   - Cross-bundle dependency ordering (`deps:` field). v1 loads bundles
//     in alphabetical-directory order; circular / dependent bundles aren't
//     supported.
//   - Bundle install / scaffold logic — that's `dome init` (later phase).
//   - External-handler registration — Phase 9+ adds the
//     `external-handlers/` directory scan.
//   - Per-bundle preamble / page-types loading — Phase 9+ adds those.
//
// House-style notes (matches src/engine/vault-runtime.ts, src/git.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Errors surface via `Result<T, E>`; never throws on expected I/O.
//   - Imports limited to v1 substrate + `node:fs/promises` + `node:path` +
//     the `yaml` package (already in package.json).

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { err, ok, type Result } from "../types";
import type { Processor } from "../core/processor";
import {
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
  readonly pageTypes: ReadonlyArray<PageTypeDeclaration>;
  readonly bundlePath: string;
};

/**
 * The closed set of `loadBundles` failures.
 *
 *   - `root-not-found`: `bundlesRoot` doesn't exist or isn't a directory.
 *   - `manifest-read-failed`: a bundle's `manifest.{yaml,json}` was not
 *     readable (missing, permission denied, malformed YAML/JSON syntax).
 *   - `manifest-invalid`: the parsed payload failed `parseManifest` —
 *     either Zod shape rejection or phase × trigger matrix violation.
 *     Carries the nested `ManifestError` for the operator's error message.
 *   - `processor-module-load-failed`: a dynamic import threw, OR the
 *     imported module's default export's `(id, version, phase)` didn't
 *     match the manifest declaration. The `cause` field carries the
 *     thrown message (for import failures) or a structured "manifest
 *     declared X; module exported Y" string (for mismatches).
 *   - `processor-missing-default-export`: the imported module loaded but
 *     had no default export (or a non-object default).
 */
export type LoadBundlesError =
  | { readonly kind: "root-not-found"; readonly path: string }
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
      readonly kind: "processor-module-load-failed";
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

  // 3. Load each bundle in turn. First failure aborts.
  const loaded: LoadedBundle[] = [];
  for (const dirName of bundleDirs) {
    const bundlePath = join(rootAbs, dirName);
    const result = await loadOneBundle(bundlePath, dirName);
    if (!result.ok) return err(result.error);
    loaded.push(result.value);
  }

  const pageTypeCollisionCheck = mergePageTypeDeclarations(
    loaded.flatMap((bundle) => [...bundle.pageTypes]),
    { enforceKnownTypes: true },
  );
  if (!pageTypeCollisionCheck.ok) {
    return err({
      kind: "page-type-collision",
      cause: pageTypeCollisionCheck.error,
    });
  }

  return ok(Object.freeze(loaded));
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
  // 1. Read the manifest file. Try `manifest.yaml` first; fall back to
  //    `manifest.json` (some Phase 8 fixtures ship JSON to keep dev-friction
  //    low). Any read or parse failure becomes `manifest-read-failed` with
  //    the failing path's tail in the cause string.
  const manifestResult = await readBundleManifest(bundlePath);
  if (!manifestResult.ok) {
    return err({
      kind: "manifest-read-failed",
      bundleId: dirName,
      cause: manifestResult.error,
    });
  }
  const rawManifest = manifestResult.value;

  // 2. Validate the parsed payload. `parseManifest` runs the Zod shape
  //    check and the phase × trigger matrix check.
  const parsed = parseManifest(rawManifest);
  if (!parsed.ok) {
    return err({
      kind: "manifest-invalid",
      bundleId: dirName,
      cause: parsed.error,
    });
  }
  const manifest: Manifest = parsed.value;
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

  return ok(
    Object.freeze({
      id: manifest.id,
      version: manifest.version,
      processors: Object.freeze(processors),
      pageTypes,
      bundlePath,
    }),
  );
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
 * The declared (id, version, phase) must match the module's exported
 * (id, version, phase). The cross-check defends against a refactor that
 * renamed a processor but left the manifest stale — without it, a
 * mismatched processor would silently run under the manifest's declared
 * capabilities while exposing a different observable id.
 */
async function loadProcessorModule(
  bundlePath: string,
  bundleId: string,
  decl: ProcessorDeclaration,
): Promise<Result<Processor<unknown>, LoadBundlesError>> {
  const moduleAbs = resolve(bundlePath, decl.module);
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

  // Structural validation of the imported object's identity and executable
  // body against the manifest declaration. The manifest remains the
  // authoritative source for routing/security/execution metadata; the module
  // supplies the `run` function and must agree on id/version/phase so stale
  // bundles fail loudly instead of running under surprising names.
  const processor = defaultExport as Processor<unknown>;
  const mismatch = checkProcessorIdentity(decl, processor);
  if (mismatch !== null) {
    return err({
      kind: "processor-module-load-failed",
      bundleId,
      modulePath: decl.module,
      cause: mismatch,
    });
  }
  if (typeof processor.run !== "function") {
    return err({
      kind: "processor-module-load-failed",
      bundleId,
      modulePath: decl.module,
      cause: `manifest declared processor '${decl.id}'; module default export has no run function`,
    });
  }

  return ok(bindProcessorDeclaration(decl, processor));
}

/**
 * Verify the module's exported processor matches the manifest declaration
 * on the three identity fields. Returns null on match; a human-readable
 * mismatch message on drift.
 */
function checkProcessorIdentity(
  decl: ProcessorDeclaration,
  processor: Processor<unknown>,
): string | null {
  if (processor.id !== decl.id) {
    return `manifest declared id '${decl.id}'; module exported id '${processor.id}'`;
  }
  if (processor.version !== decl.version) {
    return `manifest declared version '${decl.version}' for processor '${decl.id}'; module exported version '${processor.version}'`;
  }
  if (processor.phase !== decl.phase) {
    return `manifest declared phase '${decl.phase}' for processor '${decl.id}'; module exported phase '${processor.phase}'`;
  }
  return null;
}

/**
 * Bind manifest-reviewed metadata onto the executable processor. This keeps
 * the manifest as the reviewable source of truth for triggers, capabilities,
 * and execution policy, while preserving the module's `run` implementation.
 */
function bindProcessorDeclaration(
  decl: ProcessorDeclaration,
  processor: Processor<unknown>,
): Processor<unknown> {
  const base = {
    id: decl.id,
    version: decl.version,
    phase: decl.phase,
    triggers: Object.freeze([...decl.triggers]),
    capabilities: Object.freeze([...decl.capabilities]),
    run: processor.run,
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
