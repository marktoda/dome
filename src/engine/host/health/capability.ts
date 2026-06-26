// engine/host/health/capability: capability-grant probes (missing grants,
// missing grant entries, grant starvation) + their formatting helpers.
import type { Capability } from "../../../core/processor";
import { canonicalVaultPath, type VaultPath } from "../../../core/vault-path";
import { compareStrings } from "../../../core/compare";
import { graphWriteCovers } from "../../core/capability-broker";
import { globMatch } from "../../core/glob-cache";
import { pathCapabilityMatches } from "../../core/path-capabilities";
import type {
  ManifestGrantEntry,
  ManifestGrantEntryRequirement,
} from "../../../extensions/manifest-schema";
import type { ProcessorRegistry } from "../../../processors/registry";
import type { HealthFinding } from "./types";

export function capabilityGrantFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
}): ReadonlyArray<HealthFinding> {
  const findings: HealthFinding[] = [];
  for (const processor of [...opts.registry.all()].sort((a, b) =>
    compareStrings(a.id, b.id),
  )) {
    const declaredKinds = capabilityKinds(processor.capabilities);
    if (declaredKinds.size === 0) continue;
    const grantedKinds = capabilityKinds(opts.resolveGrants(processor.id));
    const missingKinds = [...declaredKinds]
      .filter((kind) => !grantedKinds.has(kind))
      .sort();
    if (missingKinds.length === 0) continue;
    findings.push(
      Object.freeze({
        code: "capability.grant-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: processor.id,
        message:
          `Processor ${processor.id} declares ` +
          `${formatList(missingKinds)} but the vault config does not grant ` +
          `${missingKinds.length === 1 ? "that capability" : "those capabilities"}.`,
        summary:
          `declares ${formatList(missingKinds)} with no vault grant`,
        recovery:
          "Update .dome/config.yaml to grant the capability, or disable the " +
          "processor/bundle if the missing capability is intentionally denied.",
        capability: Object.freeze({
          processorId: processor.id,
          missingKinds: Object.freeze(missingKinds),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

export function capabilityKinds(
  capabilities: ReadonlyArray<Capability>,
): ReadonlySet<Capability["kind"]> {
  return new Set(capabilities.map((capability) => capability.kind));
}

// ----- Grant-entry probes ------------------------------------------------------
//
// `dome init --refresh-config` fills only MISSING grant keys for already
// enabled bundles — it never merges new entries into a key the vault already
// carries (grant lists are user-owned config; auto-merging is too risky). So
// a vault that predates a bundle's newer behavior keeps its old grant lists
// and silently loses that behavior: the kind is granted but the specific
// entry is not, which the kind-level `capability.grant-missing` probe cannot
// see. These probes name the exact YAML to add.
//
// The requirements are a MANIFEST CONTRIBUTION (`doctor.grantEntries`, per
// [[wiki/gotchas/operator-surfaces-enumerate-first-party]]): each bundle
// declares its own, the runtime composes active bundles' entries, and this
// evaluator stays bundle-agnostic. A row fires only when the processor is
// loaded (bundle enabled), the manifest still declares the entry, and the
// kind IS granted (a wholly missing kind is the kind-level finding's job).


type GrantEntry = ManifestGrantEntry;

export function capabilityGrantEntryFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly requirements: ReadonlyArray<ManifestGrantEntryRequirement>;
}): ReadonlyArray<HealthFinding> {
  const findings: HealthFinding[] = [];
  for (const requirement of opts.requirements) {
    const processor = opts.registry.get(requirement.processorId);
    if (processor === undefined) continue; // bundle not enabled / not loaded
    const granted = opts.resolveGrants(requirement.processorId);
    const grantedKinds = capabilityKinds(granted);
    const missing = requirement.entries.filter(
      (entry) =>
        // The manifest must still declare the entry (the table cannot
        // outlive a manifest retrenchment) ...
        grantEntryCovered(entry, processor.capabilities) &&
        // ... the kind must be granted at all (a wholly missing kind is
        // `capability.grant-missing`'s finding) ...
        grantedKinds.has(entry.kind) &&
        // ... and the granted patterns must miss the specific entry.
        !grantEntryCovered(entry, granted),
    );
    if (missing.length === 0) continue;
    findings.push(
      Object.freeze({
        code: "capability.grant-entry-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: [
          requirement.processorId,
          ...missing.map((entry) => `${entry.kind}:${entry.target}`),
        ].join("|"),
        message:
          `Processor ${requirement.processorId} declares ` +
          formatGrantEntries(missing) +
          " but the vault grant does not cover " +
          `${missing.length === 1 ? "that entry" : "those entries"}; ` +
          `${requirement.why}.`,
        summary:
          `${formatGrantEntriesTerse(missing)} declared but not covered by the vault grant`,
        recovery: requirement.recovery,
        capability: Object.freeze({
          processorId: requirement.processorId,
          missingEntries: Object.freeze(
            missing.map((entry) =>
              Object.freeze({ kind: entry.kind, target: entry.target }),
            ),
          ),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

export function grantEntryCovered(
  entry: GrantEntry,
  caps: ReadonlyArray<Capability>,
): boolean {
  if (entry.kind === "graph.write") {
    return graphWriteCovers(entry.target, caps);
  }
  const path = canonicalVaultPath(entry.target);
  if (path === null) return false;
  return pathCapabilityMatches(entry.kind, path, caps);
}

export function formatGrantEntries(entries: ReadonlyArray<GrantEntry>): string {
  return entries
    .map((entry) => `'${entry.kind}' over '${entry.target}'`)
    .join(", ");
}

export function formatGrantEntriesTerse(entries: ReadonlyArray<GrantEntry>): string {
  return entries
    .map((entry) => `'${entry.target}' ('${entry.kind}')`)
    .join(", ");
}

// ----- General grant-starvation probe ------------------------------------------
//
// Grant-scoped snapshot misses are silent: a processor whose manifest
// declares a `read`/`patch.auto` pattern the vault grant does not cover just
// never sees the files (manifest ∩ grant = ∅, no diagnostic) — this is how
// the owner's calendar weave was silently ungranted for weeks. Unlike the
// hand-curated `doctor.grantEntries` rows above, this probe is GENERAL: it
// derives a representative concrete path from every declared pattern of
// every loaded processor and reports the patterns whose representative the
// effective grant misses. Info severity by design — narrowed grants can be
// deliberate, and the effective grant already respects per-processor
// replacement grants (capability-policy resolves a replacement grant INSTEAD
// of the bundle grant, so a narrow replacement is judged against itself).
// Hand rows keep precedence: a pattern that covers a hand-row entry's target
// for the same processor + kind is skipped here (the hand row carries the
// curated messaging for that gap).

const STARVATION_KINDS = ["read", "patch.auto"] as const;
type StarvationKind = (typeof STARVATION_KINDS)[number];

export function capabilityGrantStarvationFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  /** Hand-curated rows (`doctor.grantEntries`) — these keep precedence. */
  readonly requirements: ReadonlyArray<ManifestGrantEntryRequirement>;
  /** Processor → bundle id (recovery wording); falls back to processor id. */
  readonly extensionIdFor?: (processorId: string) => string;
}): ReadonlyArray<HealthFinding> {
  const findings: HealthFinding[] = [];
  for (const processor of [...opts.registry.all()].sort((a, b) =>
    compareStrings(a.id, b.id),
  )) {
    const granted = opts.resolveGrants(processor.id);
    const grantedKinds = capabilityKinds(granted);
    const handEntries = opts.requirements
      .filter((requirement) => requirement.processorId === processor.id)
      .flatMap((requirement) => requirement.entries);
    const starved: Array<{ kind: StarvationKind; pattern: string }> = [];
    for (const capability of processor.capabilities) {
      if (capability.kind !== "read" && capability.kind !== "patch.auto") {
        continue;
      }
      const kind: StarvationKind = capability.kind;
      // A wholly missing kind is `capability.grant-missing`'s finding.
      if (!grantedKinds.has(kind)) continue;
      for (const pattern of capability.paths) {
        // Hand-row precedence: the curated row already watches this gap.
        if (
          handEntries.some(
            (entry) => entry.kind === kind && globMatch(pattern, entry.target),
          )
        ) {
          continue;
        }
        const representative = representativeTargetForPattern(pattern);
        // Nothing checkable derivable from the pattern — never a finding.
        if (representative === null) continue;
        if (pathCapabilityMatches(kind, representative, granted)) continue;
        // Deliberate-narrowing suppression: a granted pattern strictly
        // WITHIN the declared pattern (e.g. grant wiki/entities/**/*.md
        // under declared wiki/**/*.md) means the processor acts on the
        // granted subset — narrowed by choice, not silently starving. Only
        // a declared pattern with ZERO grant intersection (the
        // calendar-weave failure mode) is reported.
        if (grantNarrowsWithin(kind, pattern, granted)) continue;
        starved.push({ kind, pattern });
      }
    }
    if (starved.length === 0) continue;
    const extensionId = opts.extensionIdFor?.(processor.id) ?? processor.id;
    findings.push(
      Object.freeze({
        code: "capability.grant-starved" as const,
        severity: "info" as const,
        subject: "config" as const,
        id: [
          processor.id,
          ...starved.map((entry) => `${entry.kind}:${entry.pattern}`),
        ].join("|"),
        message:
          `Processor ${processor.id} declares ` +
          starved
            .map((entry) => `'${entry.kind}' over '${entry.pattern}'`)
            .join(", ") +
          " but the effective vault grant does not cover " +
          `${starved.length === 1 ? "that pattern" : "those patterns"}; ` +
          "grant-scoped snapshots silently omit the matching files, so the " +
          "processor never acts on them.",
        summary:
          starved
            .map((entry) => `'${entry.pattern}' (${entry.kind})`)
            .join(", ") +
          " not covered by the effective vault grant",
        recovery:
          "If the narrowing is deliberate, ignore this info finding. " +
          `Otherwise add the missing pattern(s) under ` +
          `extensions.${extensionId}.grant.<kind> in .dome/config.yaml — or ` +
          `under extensions.${extensionId}.processors.` +
          `"${processor.id}".grant when the vault carries a per-processor ` +
          "replacement grant for it.",
        capability: Object.freeze({
          processorId: processor.id,
          extensionId,
          starved: Object.freeze(
            starved.map((entry) =>
              Object.freeze({ kind: entry.kind, pattern: entry.pattern }),
            ),
          ),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

/**
 * True when some granted pattern of `kind` lies WITHIN the declared
 * pattern — detected by deriving the granted pattern's representative path
 * and asking whether the declared pattern matches it. Partial coverage
 * means the processor does act inside the granted subset, so the gap is a
 * deliberate narrowing rather than silent starvation.
 */
export function grantNarrowsWithin(
  kind: StarvationKind,
  declaredPattern: string,
  granted: ReadonlyArray<Capability>,
): boolean {
  for (const cap of granted) {
    if (cap.kind !== kind) continue;
    for (const grantedPattern of cap.paths) {
      const representative = representativeTargetForPattern(grantedPattern);
      if (representative === null) continue;
      if (globMatch(declaredPattern, representative)) return true;
    }
  }
  return false;
}

/**
 * Derive a concrete vault path that `pattern` matches, by replacing glob
 * constructs with literals: the first alternative of each `{a,b}` group,
 * `probe` for `*`/`**` runs, `x` for `?`. The derivation is sanity-checked
 * against the broker's own matcher — a pattern whose derived literal it
 * does not match (exotic character classes, etc.) yields null, and null
 * means "nothing checkable", never a finding.
 */
export function representativeTargetForPattern(pattern: string): VaultPath | null {
  const literal = pattern
    .replace(/\{([^{}]*)\}/g, (_match, body: string) => body.split(",")[0] ?? "")
    .replace(/\*+/g, "probe")
    .replace(/\?/g, "x");
  const path = canonicalVaultPath(literal);
  if (path === null) return null;
  return globMatch(pattern, path) ? path : null;
}


export function formatList(values: ReadonlyArray<string>): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `'${values[0]}'`;
  return values.map((value) => `'${value}'`).join(", ");
}
