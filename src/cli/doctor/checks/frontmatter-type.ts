// Page-type / frontmatter integrity check.
//
// Owns four related concerns that share the page-type catalogue:
//   1. Frontmatter `type:` matches the directory it lives in (CHECK 1).
//   2. Frontmatter fields outside the known per-type schema emit soft-warning
//      info per page-schema.md §"Extension types" (CHECK 4).
//   3. Unknown wiki subdirectories (not in the page-types config) are flagged
//      as violations (CHECK 5).
//   4. Declared page-type extensions that no page actually uses surface as
//      info hints (CHECK 8).
//
// All four concerns share `knownPluralDirs`, `declaredExtensionTypes`, and
// the per-type frontmatter field catalogue — keeping them in one module
// avoids re-deriving that state across modules.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";
import { pluralOf, singularOf } from "../../../page-type";
import { walkWikiPages } from "../internal/walk-wiki-pages";
import type { CheckResult } from "./types";

// Universal frontmatter keys allowed on EVERY wiki page (per page-schema.md
// §"Universal frontmatter"). Per-type extensions are layered on top via
// PER_TYPE_FRONTMATTER_FIELDS (defaults) + the vault's page-types.yaml
// extensions[].frontmatter_extras.
const UNIVERSAL_FRONTMATTER_FIELDS: ReadonlyArray<string> = ["type", "created", "updated", "sources"];

// Per-type optional frontmatter fields for the four DEFAULT page types per
// page-schema.md §"Page-type-specific extensions". Vault-declared extension
// types (`spec`, `invariant`, `matrix`, `gotcha`, …) bring their own fields
// via .dome/page-types.yaml `extensions[].frontmatter_extras`; doctor reads
// those at runtime.
const PER_TYPE_FRONTMATTER_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  entity: ["aliases", "tags"],
  concept: ["aliases", "tags", "status"],
  source: ["url", "author", "external"],
  synthesis: ["status", "supersedes"],
};

// Pluralized wiki subdirectory -> singular page type (per PAGE_TYPE_BY_DIRECTORY).
// Delegated to the canonical page-type module so doctor and writeDocument stay
// in lockstep on plural/singular derivation.
const expectedPageTypeForDir = (dirName: string): string => singularOf(dirName);

export async function checkFrontmatterType(vault: Vault): Promise<CheckResult> {
  const violations: string[] = [];
  const info: string[] = [];

  const wikiRoot = join(vault.path, "wiki");

  // Page-type catalogue: dirs that are legitimate per the vault's page-type
  // config. Used for short-form wikilink resolution and unknown-dir checks.
  const knownPluralDirs = new Set<string>([
    ...vault.pageTypes.defaults.map(t => pluralOf(t)),
    ...vault.pageTypes.extensions.map(e => pluralOf(typeof e === "string" ? e : e.name)),
  ]);
  // Always-allowed structural directories under wiki/ even if no pages of that
  // type exist yet. invariants/, specs/, gotchas/ ship as documentation
  // surfaces in the dogfooded Dome vault itself.
  for (const d of ["invariants", "specs", "gotchas"]) knownPluralDirs.add(d);

  // Track which extension page-types are actually used (for the "unused
  // extensions" check).
  const usedExtensionTypes = new Set<string>();
  const declaredExtensionTypes = new Set<string>(
    vault.pageTypes.extensions.map(e => typeof e === "string" ? e : e.name)
  );
  // Build the per-type frontmatter field catalogue from defaults + vault's
  // extensions[].frontmatter_extras. Extensions in short-form (just a name)
  // contribute no extras — doctor flags only fields outside the union.
  const perTypeFields: Record<string, ReadonlyArray<string>> = { ...PER_TYPE_FRONTMATTER_FIELDS };
  for (const ext of vault.pageTypes.extensions) {
    if (typeof ext === "string") {
      perTypeFields[ext] = perTypeFields[ext] ?? [];
      continue;
    }
    const extras = ext.frontmatter_extras;
    perTypeFields[ext.name] = extras !== undefined ? Object.keys(extras) : [];
  }

  // Walk every wiki page once and run all per-page checks together.
  for await (const { subdir, rel } of walkWikiPages(vault)) {
    // Track which extension types are used.
    if (declaredExtensionTypes.has(expectedPageTypeForDir(subdir))) {
      usedExtensionTypes.add(expectedPageTypeForDir(subdir));
    }

    const out = await vault.tools.readDocument({ path: rel });
    if (!out.result.ok) continue;
    const doc = out.result.value;

    // CHECK 1 (existing): frontmatter type matches directory.
    const expectedType = expectedPageTypeForDir(subdir);
    if (doc.frontmatter.type && doc.frontmatter.type !== expectedType) {
      violations.push(`${rel}: frontmatter type=${doc.frontmatter.type} does not match directory ${subdir}`);
    }

    // CHECK 4 (new): frontmatter fields outside the known per-type schema.
    // Per page-schema.md §"Extension types" line 125: "Unknown fields trigger
    // a soft warning (logged to log.md) but not a rejection". Doctor surfaces
    // them as info, not as exit-code-affecting violations.
    const docType = doc.frontmatter.type;
    if (typeof docType === "string") {
      const allowed = new Set<string>([
        ...UNIVERSAL_FRONTMATTER_FIELDS,
        ...(perTypeFields[docType] ?? []),
      ]);
      for (const key of Object.keys(doc.frontmatter)) {
        if (!allowed.has(key)) {
          info.push(`${rel}: unknown frontmatter field "${key}" for type=${docType} (soft warning per page-schema.md)`);
        }
      }
    }
  }

  // CHECK 5 (new): unknown wiki subdirectories (not in page-types config).
  if (existsSync(wikiRoot)) {
    const subdirs = await readdir(wikiRoot, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      if (!knownPluralDirs.has(subdir.name)) {
        violations.push(`wiki/${subdir.name}/: unknown wiki subdirectory (not in page-types config)`);
      }
    }
  }

  // CHECK 8 (new): unused page-type extensions (declared in page-types.yaml
  // but no page actually uses them — best-effort hint, info-only).
  for (const ext of declaredExtensionTypes) {
    if (!usedExtensionTypes.has(ext)) {
      info.push(`page-type extension "${ext}" declared but no page uses it`);
    }
  }

  return { violations, info };
}
