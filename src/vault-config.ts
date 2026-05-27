// src/vault-config.ts
//
// loadVaultConfig — extracts the config-and-page-types loader from openVault.
// Pure I/O; reads `.dome/config.yaml` and `.dome/page-types.yaml` with shipped-
// default fallback. The shape mirrors the inline logic that lived in
// `openVault` prior to the v0.5 → v1 tightening, so the upcoming refactor
// (`openVault` → call `loadVaultConfig`) is a straight substitution.
//
// `loadVaultConfig` does NOT walk up the directory tree to find a vault root;
// that's `openVault`'s job (via `findVaultRoot`). The caller passes an already-
// resolved root, and `loadVaultConfig` reads the two YAML files at that root.
//
// Validation: parsed YAML flows through `VaultConfigSchema` /
// `PageTypesConfigSchema` (Zod) rather than `as Partial<VaultConfig>` casts.
// A malformed `config.yaml` surfaces as `config-invalid`; a malformed
// `page-types.yaml` falls back to shipped defaults with a console warning
// (page-types has always been optional). See
// docs/wiki/gotchas/boundary-validation-via-zod.md.
//
// See docs/wiki/specs/sdk-surface.md §"Composable construction".

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError } from "./types";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "./shipped-defaults";
import type { VaultConfig, PageTypesConfig } from "./vault";
import { VaultConfigSchema, PageTypesConfigSchema } from "./vault-schemas";
import { loadExtensionBundles, type ExtensionBundle } from "./extensions";

export interface LoadedVaultConfig {
  config: VaultConfig;
  pageTypes: PageTypesConfig;
  bundles: readonly ExtensionBundle[];
}

/**
 * Read `.dome/config.yaml` and `.dome/page-types.yaml` at `root`, merging with
 * shipped defaults. Returns a Result so a malformed `config.yaml` can be
 * surfaced as `config-invalid` (matching the existing `openVault` behavior)
 * rather than thrown. A missing `page-types.yaml` falls back to shipped
 * defaults silently — page-types is optional.
 */
export async function loadVaultConfig(root: string): Promise<Result<LoadedVaultConfig, ToolError>> {
  let config: VaultConfig = SHIPPED_VAULT_CONFIG;
  let pageTypes: PageTypesConfig = SHIPPED_PAGE_TYPES;

  // config.yaml — required. Read failures (missing file, permission denied)
  // and schema-validation failures both translate to `config-invalid` so the
  // caller (openVault) surfaces a single failure kind to the user.
  let cfgText: string;
  try {
    cfgText = await readFile(join(root, ".dome", "config.yaml"), "utf8");
  } catch (e: unknown) {
    return err({ kind: "config-invalid", message: `Failed to read .dome/config.yaml: ${(e as Error).message}` });
  }
  let cfgRaw: unknown;
  try {
    cfgRaw = parseYaml(cfgText);
  } catch (e: unknown) {
    return err({ kind: "config-invalid", message: `Failed to parse .dome/config.yaml: ${(e as Error).message}` });
  }
  const cfgParsed = VaultConfigSchema.safeParse(cfgRaw);
  if (!cfgParsed.success) {
    return err({
      kind: "config-invalid",
      message: `Invalid .dome/config.yaml shape: ${cfgParsed.error.issues[0]?.message ?? cfgParsed.error.message}`,
    });
  }
  const parsed = cfgParsed.data;
  // Build the merged config field-by-field rather than via blanket spread —
  // Zod's `.optional()` produces `field?: T | undefined` shapes, and a
  // straight spread of `parsed.hooks` would propagate `undefined` values
  // for `max_causation_depth` / `inbox_stale_age_hours` and break the
  // non-optional `VaultConfig` interface. Each numeric/boolean leaf falls
  // back to the shipped default explicitly.
  config = {
    invariants: { ...SHIPPED_VAULT_CONFIG.invariants, ...(parsed.invariants ?? {}) },
    hooks: {
      builtin: { ...SHIPPED_VAULT_CONFIG.hooks.builtin, ...(parsed.hooks?.builtin ?? {}) },
      max_causation_depth: parsed.hooks?.max_causation_depth ?? SHIPPED_VAULT_CONFIG.hooks.max_causation_depth,
      inbox_stale_age_hours: parsed.hooks?.inbox_stale_age_hours ?? SHIPPED_VAULT_CONFIG.hooks.inbox_stale_age_hours,
    },
    git: {
      auto_commit_workflows: parsed.git?.auto_commit_workflows ?? SHIPPED_VAULT_CONFIG.git.auto_commit_workflows,
    },
  };

  // page-types.yaml — optional. A missing file is silent fallback (always
  // has been); a malformed file falls back to shipped defaults with a
  // console.warn so the user sees the problem without crashing `openVault`.
  try {
    const ptText = await readFile(join(root, ".dome", "page-types.yaml"), "utf8");
    let ptRaw: unknown;
    try {
      ptRaw = parseYaml(ptText);
    } catch (e: unknown) {
      console.warn(`Invalid .dome/page-types.yaml: ${(e as Error).message}; using shipped defaults`);
      return ok({ config, pageTypes });
    }
    const ptParsed = PageTypesConfigSchema.safeParse(ptRaw);
    if (!ptParsed.success) {
      console.warn(
        `Invalid .dome/page-types.yaml shape: ${ptParsed.error.issues[0]?.message ?? ptParsed.error.message}; using shipped defaults`,
      );
    } else {
      // The schema infers `defaults?: string[]` but the canonical type uses
      // `ReadonlyArray<string>`; a runtime spread satisfies both. Same for
      // `extensions`. The shape is structurally compatible — the cast here
      // is narrowing the optional-modifier off, not loosening the value
      // shape.
      pageTypes = { ...SHIPPED_PAGE_TYPES, ...ptParsed.data } as PageTypesConfig;
    }
  } catch {
    // page-types.yaml is optional — silent fallback for missing file.
  }

  // Extension bundles — scan `<root>/.dome/extensions/<bundle>/` and merge
  // each bundle's `page-types.yaml extensions:` into PageTypesConfig.extensions
  // with collision detection. Fail-loud per
  // docs/wiki/gotchas/extension-bundle-load-order.md.
  const bundlesResult = await loadExtensionBundles(root);
  if (!bundlesResult.ok) return bundlesResult;
  const bundles = bundlesResult.value;

  const merged: Array<string | { name: string; frontmatter_extras?: Record<string, unknown> }> = [
    ...pageTypes.extensions,
  ];
  const seenNames = new Set<string>(
    merged.map((e) => (typeof e === "string" ? e : e.name)),
  );
  const provenance = new Map<string, string>();

  for (const bundle of bundles) {
    if (bundle.pageTypesPath === null) continue;
    let bundleText: string;
    try {
      bundleText = await readFile(bundle.pageTypesPath, "utf8");
    } catch (e) {
      return err({
        kind: "bundle-load-failure",
        detail: "manifest-invalid",
        message: `bundle '${bundle.name}': cannot read page-types.yaml: ${String(e)}`,
      });
    }
    let parsed: { extensions?: ReadonlyArray<unknown> } | null;
    try {
      parsed = parseYaml(bundleText) as { extensions?: ReadonlyArray<unknown> } | null;
    } catch (e) {
      return err({
        kind: "bundle-load-failure",
        detail: "manifest-invalid",
        message: `bundle '${bundle.name}': failed to parse page-types.yaml: ${String(e)}`,
      });
    }
    for (const ext of parsed?.extensions ?? []) {
      const extName = typeof ext === "string" ? ext : (ext as { name: string }).name;
      if (seenNames.has(extName)) {
        const otherSource = provenance.get(extName) ?? "vault-local .dome/page-types.yaml";
        return err({
          kind: "bundle-load-failure",
          detail: "page-type-collision",
          message: `bundle '${bundle.name}' declares page type '${extName}'; already declared by ${otherSource}`,
        });
      }
      seenNames.add(extName);
      provenance.set(extName, `bundle '${bundle.name}'`);
      merged.push(ext as string | { name: string; frontmatter_extras?: Record<string, unknown> });
    }
  }

  const mergedPageTypes: PageTypesConfig = {
    defaults: pageTypes.defaults,
    extensions: merged,
  };

  return ok({ config, pageTypes: mergedPageTypes, bundles });
}
