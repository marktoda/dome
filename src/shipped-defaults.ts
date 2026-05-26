// Single source of truth for "what does a fresh Dome vault ship with" —
// typed config values plus YAML serializers for the on-disk projection.
//
// Three call sites used to carry parallel copies of these defaults: the
// runtime fallback in `vault.ts` (typed), the `dome init` / `dome migrate`
// scaffolder in `vault-scaffold.ts` (YAML), and test/eval vault factories
// (YAML). They had already drifted in practice — see
// docs/wiki/specs/sdk-surface.md §"Tiered feature model" for the catalog
// these defaults realize.
//
// Consumers that need the typed shape import the constants directly.
// Consumers that need a YAML file on disk call the serializer helpers.

import { stringify as yamlStringify } from "yaml";
import type { VaultConfig, PageTypesConfig } from "./vault";

export const SHIPPED_VAULT_CONFIG: VaultConfig = {
  invariants: {
    EVERY_WRITE_IS_LOGGED: "enabled",
    PAGE_TYPE_BY_DIRECTORY: "enabled",
    WIKILINKS_ARE_FULLPATH: "enabled",
    INBOX_IS_EPHEMERAL: "enabled",
    PAGE_CREATION_REQUIRES_RECURRENCE: "disabled",
    AGENTS_MD_IS_ORIENTATION_SURFACE: "enabled",
    VAULT_RECONCILES_AFTER_NATIVE_WRITE: "enabled",
  },
  hooks: {
    builtin: {
      "auto-update-index": "enabled",
      "auto-cross-reference": "enabled",
      "log-out-of-band-write": "enabled",
    },
    max_causation_depth: 50,
    inbox_stale_age_hours: 24,
  },
  git: { auto_commit_workflows: true },
};

export const SHIPPED_PAGE_TYPES: PageTypesConfig = {
  defaults: ["entity", "concept", "source", "synthesis"],
  extensions: [],
};

/** YAML body for `.dome/config.yaml` — derived from {@link SHIPPED_VAULT_CONFIG}. */
export function shippedConfigYaml(): string {
  return `# Dome vault config\n${yamlStringify(SHIPPED_VAULT_CONFIG)}`;
}

/** YAML body for `.dome/page-types.yaml` — derived from {@link SHIPPED_PAGE_TYPES}. */
export function shippedPageTypesYaml(): string {
  return yamlStringify(SHIPPED_PAGE_TYPES);
}
