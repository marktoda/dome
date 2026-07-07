// cli/commands/init-config-merge: the `--refresh-config` first-party default
// reconciliation — `dome init`'s densest concern, extracted behind a
// two-function interface (cohesion review 2026-07-07). Pure
// YAML-Document-in, `{changed, grantsAdded}`-out; no filesystem coupling
// beyond reading the shipped manifests for the merge gate.
//
// Two distinct edits, both insert-only (never remove or narrow an existing
// entry; b681311's comment-preserving Document-API path is used throughout):
//
//   1. A MISSING first-party bundle stanza is added. On a legacy enumerated
//      vault it carries its FULL shipped default grant block (bundle grant +
//      per-processor replacement grants) so the bundle is not stranded
//      grantless — the failure mode NEEDS_ARE_LOUD incident #4 named. On a
//      `grants: standard` vault it is added enabled-only (the preset supplies
//      the grants).
//
//   2. A PRESENT, enabled first-party bundle on a legacy enumerated vault is
//      brought up to the shipped default. A grant KIND the default declares but
//      the vault omits entirely (`patch.auto`, `graph.write`, `question.ask`, …)
//      lands at its full default — a capability the bundle's processors gained
//      since the config was written (the kind-level `capability.grant-missing`
//      starvation, NEEDS_ARE_LOUD incident #4). A kind the vault DOES list is
//      owner-authored and is merged into only surgically, gated by the bundle
//      manifest's `doctor.grantEntries` — the same rows `dome doctor`'s
//      `capability.grant-entry-missing` probe checks. Such a bundle-level entry
//      adds the most-specific shipped default glob that covers the entry's
//      target (a probe target like `sources/calendar/2026-01-01.md` yields the
//      default glob `sources/calendar/*.md`, and `core.md` yields `core.md`,
//      never `**/*.md` — a deliberately narrowed list survives). Per-processor
//      entries (whose processor has a shipped replacement grant) add the full
//      replacement stanza when the vault carries none, matching the doctor
//      recovery text. A `grants: standard` vault skips (2) entirely — the preset
//      already tracks defaults.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";

import {
  configRoot,
  ensureMapAt,
  mapAt,
} from "../../config-document";
import {
  type DefaultGrantValue,
  type FirstPartyExtensionDefault,
  FIRST_PARTY_EXTENSION_DEFAULTS,
} from "../default-vault-config";
import { globMatch } from "../../engine/core/glob-cache";
import {
  parseManifest,
  type ManifestGrantEntryRequirement,
} from "../../extensions/manifest-schema";
import { resolveShippedBundlesRoot } from "./sync-shared";

/**
 * Read the shipped first-party bundle manifests and return each bundle's
 * `doctor.grantEntries` requirements, keyed by bundle id. These are the same
 * declarative rows `dome doctor`'s `capability.grant-entry-missing` probe
 * evaluates; `--refresh-config` uses them as the merge gate so it fills exactly
 * the load-bearing grants a legacy enumerated vault is missing (not the whole
 * default block, which would undo an owner's deliberate narrowing). A manifest
 * that won't parse is skipped — that broader failure surfaces via `dome doctor`
 * / `dome serve`, and refresh just declines to merge for that bundle.
 */
export async function loadFirstPartyDoctorGrantEntries(): Promise<
  Map<string, ReadonlyArray<ManifestGrantEntryRequirement>>
> {
  const root = resolveShippedBundlesRoot();
  const byId = new Map<string, ReadonlyArray<ManifestGrantEntryRequirement>>();
  for (const def of FIRST_PARTY_EXTENSION_DEFAULTS) {
    try {
      const manifestPath = join(root, def.id, "manifest.yaml");
      if (!existsSync(manifestPath)) continue;
      const parsed = parseManifest(parseDocument(await readFile(manifestPath, "utf8")).toJSON());
      if (!parsed.ok) continue;
      const entries = parsed.value.doctor?.grantEntries ?? [];
      if (entries.length > 0) byId.set(def.id, entries);
    } catch {
      // Unreadable shipped manifest — skip this bundle's grant merge.
    }
  }
  return byId;
}

export function refreshFirstPartyDefaultConfig(
  doc: Document,
  grantMergeEnabled: boolean,
  doctorEntriesById: ReadonlyMap<string, ReadonlyArray<ManifestGrantEntryRequirement>>,
): { readonly changed: boolean; readonly grantsAdded: ReadonlyArray<string> } {
  const extensions = mapAt(configRoot(doc), "extensions");
  if (extensions === null) return { changed: false, grantsAdded: [] };

  let changed = false;
  const grantsAdded: string[] = [];
  const sorted = [...FIRST_PARTY_EXTENSION_DEFAULTS].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const def of sorted) {
    if (!extensions.has(def.id)) {
      extensions.set(
        doc.createNode(def.id),
        doc.createNode(missingBundleStanza(def, grantMergeEnabled)),
      );
      changed = true;
      grantsAdded.push(
        grantMergeEnabled
          ? `${def.id} (bundle added with default grants)`
          : `${def.id} (bundle added)`,
      );
      continue;
    }

    const extension = mapAt(extensions, def.id);
    if (extension === null) continue;
    if (extension.get("enabled") !== true) continue;
    // `grants: standard` vaults keep the preset as the single source of grants:
    // present bundles are left byte-untouched.
    if (!grantMergeEnabled) continue;

    const requirements = doctorEntriesById.get(def.id) ?? [];
    const grantKey = grantKeyFor(extension);
    // A non-mapping grant value (`grant: off`) is user-owned config the refresh
    // has no safe way to reconcile — leave the whole bundle alone.
    const existingGrant = extension.get(grantKey);
    if (existingGrant !== undefined && !isMap(existingGrant)) continue;
    const bundleGrant = ensureMapAt(doc, extension, grantKey);

    // (1) Fill wholly-missing default grant KINDS with the full shipped default.
    // A kind the enumerated grant does not list at all is a capability the
    // bundle's processors gained since the config was written — the
    // "arrives capability-starved" gap (NEEDS_ARE_LOUD incident #4), and the
    // kind-level `capability.grant-missing` doctor finding. There is no
    // owner-authored value to respect, so the whole default lands. A kind the
    // vault DOES list is owner-authored and is only merged into surgically (2).
    for (const kind of Object.keys(def.grant)) {
      if (bundleGrant.has(kind)) continue;
      bundleGrant.set(doc.createNode(kind), doc.createNode(structuredClone(def.grant[kind])));
      changed = true;
      grantsAdded.push(`${def.id}.${grantKey}.${kind} (default grant added)`);
    }

    // (2) Merge the load-bearing `doctor.grantEntries` into kinds the vault
    // already carries (surgical — respects a deliberately narrowed list) and
    // add per-processor replacement grants the vault lacks.
    for (const requirement of requirements) {
      const replacement = def.processors?.[requirement.processorId];
      if (replacement !== undefined) {
        if (
          addPerProcessorReplacementGrant(doc, extension, requirement.processorId, replacement)
        ) {
          changed = true;
          grantsAdded.push(
            `${def.id}.processors."${requirement.processorId}".grant (replacement grant added)`,
          );
        }
        continue;
      }
      for (const entry of requirement.entries) {
        const added = mergeGrantEntry(
          doc,
          bundleGrant,
          entry.kind,
          entry.target,
          def.grant[entry.kind],
        );
        if (added !== null) {
          changed = true;
          grantsAdded.push(`${def.id}.${grantKey}.${entry.kind} += ${JSON.stringify(added)}`);
        }
      }
    }
  }
  return { changed, grantsAdded };
}

/**
 * The stanza inserted for a first-party bundle that a refreshed config lacks.
 * On a legacy enumerated vault it carries the full shipped default grant block
 * (bundle grant + per-processor replacement grants, each wrapped as
 * `processors.<id>.grant`). On a `grants: standard` vault it is enabled-only
 * (with any shipped `config:`), leaving the preset to supply grants.
 */
function missingBundleStanza(
  def: FirstPartyExtensionDefault,
  grantMergeEnabled: boolean,
): Record<string, unknown> {
  const stanza: Record<string, unknown> = { enabled: def.enabled };
  if (def.config !== undefined) stanza.config = structuredClone(def.config);
  if (!grantMergeEnabled) return stanza;
  stanza.grant = structuredClone(def.grant);
  if (def.processors !== undefined) {
    stanza.processors = Object.fromEntries(
      Object.entries(def.processors).map(([procId, grant]) => [
        procId,
        { grant: structuredClone(grant) },
      ]),
    );
  }
  return stanza;
}

/**
 * Add a per-processor replacement grant stanza
 * (`extensions.<bundle>.processors.<id>.grant`) from the shipped default when
 * the vault carries none for that processor. An existing per-processor block is
 * user-owned config — left untouched.
 */
function addPerProcessorReplacementGrant(
  doc: Document,
  extension: YAMLMap,
  processorId: string,
  grant: Readonly<Record<string, DefaultGrantValue>>,
): boolean {
  const processors = ensureMapAt(doc, extension, "processors");
  if (processors.has(processorId)) return false;
  processors.set(
    doc.createNode(processorId),
    doc.createNode({ grant: structuredClone(grant) }),
  );
  return true;
}

/**
 * Merge one missing grant entry into a bundle grant list. Returns the glob
 * added, or null when nothing was added (already covered, no covering default
 * glob, or a value refresh must respect). The glob added is the most-specific
 * shipped default glob that covers `target`, so a doctor probe target resolves
 * to the canonical default pattern rather than a one-off path, and a narrow
 * default (e.g. `core.md`) wins over a broad one (`**\/*.md`).
 */
function mergeGrantEntry(
  doc: Document,
  grantMap: YAMLMap,
  kind: string,
  target: string,
  defaultValue: DefaultGrantValue | undefined,
): string | null {
  const covering = grantGlobList(defaultValue).filter((glob) => globMatch(glob, target));
  if (covering.length === 0) return null;
  const glob = mostSpecificGlob(covering);

  const existing = grantMap.get(kind);
  if (existing === undefined) {
    grantMap.set(doc.createNode(kind), doc.createNode([glob]));
    return glob;
  }
  // A scalar grant value (`read: off`, `question.ask: false`) is user-owned
  // config the refresh has no safe way to merge a list entry into — leave it
  // alone.
  if (!isSeq(existing)) return null;
  const items = existing.toJSON() as unknown[];
  // An explicitly EMPTY list is deliberate withholding, not stale config
  // (omission ≠ withholding — wiki/specs/cli.md §"dome init"): never merged
  // into, even when a doctor row names a missing entry for the kind.
  if (items.length === 0) return null;
  const covered = items.some(
    (item) => typeof item === "string" && globMatch(item, target),
  );
  if (covered || items.includes(glob)) return null;
  existing.add(doc.createNode(glob));
  return glob;
}

/** The string globs of a shipped default grant value (a path/namespace list). */
function grantGlobList(value: DefaultGrantValue | undefined): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The most-specific glob: fewest `*` wildcards, then longest, then lexical.
 * `core.md` beats `**\/*.md`; `sources/calendar/*.md` is the sole cover for a
 * dated probe path.
 */
function mostSpecificGlob(globs: ReadonlyArray<string>): string {
  return [...globs].sort((a, b) => {
    const byStars = starCount(a) - starCount(b);
    if (byStars !== 0) return byStars;
    if (a.length !== b.length) return b.length - a.length;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
}

function starCount(glob: string): number {
  let n = 0;
  for (const ch of glob) if (ch === "*") n += 1;
  return n;
}

function grantKeyFor(extension: YAMLMap): "grant" | "grants" {
  return extension.has("grants") && !extension.has("grant")
    ? "grants"
    : "grant";
}
