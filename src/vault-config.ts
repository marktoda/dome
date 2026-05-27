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
// See docs/wiki/specs/sdk-surface.md §"Composable construction".

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError } from "./types";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "./shipped-defaults";
import type { VaultConfig, PageTypesConfig } from "./vault";

export interface LoadedVaultConfig {
  config: VaultConfig;
  pageTypes: PageTypesConfig;
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
  try {
    const cfgText = await readFile(join(root, ".dome", "config.yaml"), "utf8");
    const parsed = parseYaml(cfgText) as Partial<VaultConfig>;
    config = { ...SHIPPED_VAULT_CONFIG, ...parsed,
      invariants: { ...SHIPPED_VAULT_CONFIG.invariants, ...(parsed.invariants ?? {}) },
      hooks: { ...SHIPPED_VAULT_CONFIG.hooks, ...(parsed.hooks ?? {}),
        builtin: { ...SHIPPED_VAULT_CONFIG.hooks.builtin, ...((parsed.hooks?.builtin) ?? {}) } },
      git: { ...SHIPPED_VAULT_CONFIG.git, ...(parsed.git ?? {}) },
    };
  } catch (e: unknown) {
    return err({ kind: "config-invalid", message: `Failed to parse .dome/config.yaml: ${(e as Error).message}` });
  }
  try {
    const ptText = await readFile(join(root, ".dome", "page-types.yaml"), "utf8");
    const parsed = parseYaml(ptText) as Partial<PageTypesConfig>;
    pageTypes = { ...SHIPPED_PAGE_TYPES, ...parsed };
  } catch {
    // page-types is optional
  }
  return ok({ config, pageTypes });
}
