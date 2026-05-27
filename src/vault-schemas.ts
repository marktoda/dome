// Zod schemas for the two YAML files that live under `.dome/`. Colocated
// with their loader (`vault-config.ts` consumes them) so the next reader of
// the loader sees the validated shape first. Closes the second scar site
// named in docs/wiki/gotchas/boundary-validation-via-zod.md.
//
// Schema shape is a strict mirror of the `VaultConfig` and `PageTypesConfig`
// types declared in `src/vault.ts`; the `.passthrough()` on each top-level
// object lets a forward-compatible field (e.g., a v0.5.2-only key) slide
// through without rejecting the whole config. The fallback path in
// `loadVaultConfig` re-merges with shipped defaults, so passthrough fields
// land in the assembled VaultConfig as-is.

import { z } from "zod";

const InvariantEnableSchema = z.enum(["enabled", "disabled"]);

/**
 * `.dome/config.yaml` shape. Matches the `VaultConfig` interface declared in
 * `src/vault.ts` field-for-field. The top-level object uses `.passthrough()`
 * for forward compatibility — `loadVaultConfig` deep-merges parsed values
 * over shipped defaults rather than replacing the structure wholesale.
 *
 * All sub-objects are optional because a user-edited config may carry just
 * one section (e.g., only `git:`); the loader fills the rest from shipped
 * defaults.
 */
export const VaultConfigSchema = z
  .object({
    invariants: z.record(z.string(), InvariantEnableSchema).optional(),
    hooks: z
      .object({
        builtin: z.record(z.string(), InvariantEnableSchema).optional(),
        max_causation_depth: z.number().int().positive().optional(),
        inbox_stale_age_hours: z.number().positive().optional(),
      })
      .passthrough()
      .optional(),
    git: z
      .object({
        auto_commit_workflows: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Inferred from `VaultConfigSchema`. Used only inside `loadVaultConfig`;
 * the canonical `VaultConfig` interface (from `src/vault.ts`) is the public
 * type that callers consume. */
export type ParsedVaultConfig = z.infer<typeof VaultConfigSchema>;

/**
 * `.dome/page-types.yaml` shape. Matches the `PageTypesConfig` interface
 * declared in `src/vault.ts` — `defaults` is a list of directory names, and
 * `extensions` is an array of either bare-string names or named-extension
 * objects with optional `frontmatter_extras`.
 */
export const PageTypesConfigSchema = z
  .object({
    defaults: z.array(z.string()).optional(),
    extensions: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              name: z.string(),
              frontmatter_extras: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough(),
        ]),
      )
      .optional(),
  })
  .passthrough();

/** Inferred from `PageTypesConfigSchema`. See note on `ParsedVaultConfig`. */
export type ParsedPageTypesConfig = z.infer<typeof PageTypesConfigSchema>;
