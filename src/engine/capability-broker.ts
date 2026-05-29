// Capability broker — the single chokepoint that gates every Effect.
//
// Pure decision function: given an Effect plus the emitting processor's
// declared capabilities (from `manifest.yaml`) plus the vault's granted
// capabilities (from `<vault>/.dome/config.yaml`), returns one of:
//
//   - `allow`     — effect proceeds as-is.
//   - `downgrade` — effect rewritten to a safer form (PatchEffect auto→propose).
//   - `deny`      — effect discarded; diagnostic emitted.
//
// No I/O — no filesystem, sqlite, git, network. The broker is composed into
// `src/engine/apply-effect.ts` (Phase 2.x), which is the only call site per
// [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].
//
// Normative references:
//   - docs/wiki/specs/capabilities.md §"Enforcement chokepoint"
//   - docs/wiki/matrices/effect-x-capability.md
//   - docs/wiki/specs/effects.md §"The Effect union"
//
// v1 limitations (documented for downstream phases):
//   - PatchEffect enforcement emits one verdict per effect, not per change.
//     The verdict is computed against every changed path: an auto patch is
//     auto-applied only when every path has effective `patch.auto`, and it is
//     downgraded only when every path has effective `patch.propose`.
//     A PatchEffect with an empty `changes` list is structurally impossible
//     (`PatchEffectSchema` enforces `.min(1)`); the broker defensively denies
//     if it ever sees one.
//   - `owns.region` is a planned generated-region ownership capability, but
//     it is not enforceable until the engine has a region parser at the
//     patch boundary. Runtime config and manifests reject it in v1. If a
//     hand-built test/runtime still passes it to the broker, PatchEffect is
//     denied rather than pretending the region boundary is safe. `owns.path`
//     is enforced here: a path-bearing PatchEffect targeting a path matched
//     by a granted `owns.path` capability that the emitting processor's
//     declared capabilities do not include is denied with a
//     `capability-deny-patch` diagnostic.
//   - Content/user-visible SourceRefs are broker-checked against the
//     processor's effective `read` grant after the effect-kind-specific
//     capability check succeeds. This prevents processors from bypassing
//     the scoped `ctx.sourceRef()` helper by importing the raw constructor.
//
// House-style notes (matches src/core/source-ref.ts,
// src/core/effect.ts, src/engine/compile-range.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Exhaustive `switch` on `Effect.kind` with a `never`-typed catch-all
//     so adding an Effect kind is a compile error here.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating broker outputs.
//   - Imports limited to pure types from `../core/` plus the
//     `diagnosticEffect` constructor helper. No runtime dependency on
//     filesystem, git, sqlite, or network.

import type {
  DiagnosticEffect,
  Effect,
  ExternalActionEffect,
  FactEffect,
  JobEffect,
  OutboxRecoveryEffect,
  PatchEffect,
  QuarantineRecoveryEffect,
  RunRecoveryEffect,
  SearchDocumentEffect,
} from "../core/effect";
import { diagnosticEffect, patchEffect } from "../core/effect";
import type { Capability } from "../core/processor";
import type { SourceRef } from "../core/source-ref";
import {
  pathCapabilityEffectiveFor,
  pathIsOwnedByThirdParty,
  readablePath,
} from "./path-capabilities";
import { globMatch } from "./glob-cache";

// ----- EnforcementResult ----------------------------------------------------

/**
 * The broker's verdict for one Effect. The discriminator `kind` round-trips
 * cleanly: `if (result.kind === "downgrade") result.rewrittenEffect` narrows
 * to the PatchEffect-with-propose-mode rewrite. `deny` and `downgrade` both
 * carry a `DiagnosticEffect` the caller appends to the effect stream so the
 * user sees the surprise.
 */
export type EnforcementResult =
  | { readonly kind: "allow" }
  | {
      readonly kind: "downgrade";
      readonly rewrittenEffect: Effect;
      readonly diagnostic: DiagnosticEffect;
    }
  | {
      readonly kind: "deny";
      readonly diagnostic: DiagnosticEffect;
      readonly deniedCapability?: DeniedCapability;
    };

export type DeniedCapability = {
  readonly capability: string;
  readonly resource: string | null;
};

/** Frozen singleton for the common case — avoid per-call allocation. */
const ALLOW: EnforcementResult = Object.freeze({ kind: "allow" } as const);

const allow = (): EnforcementResult => ALLOW;

const deny = (
  diagnostic: DiagnosticEffect,
  deniedCapability?: DeniedCapability,
): EnforcementResult =>
  Object.freeze({
    kind: "deny",
    diagnostic,
    ...(deniedCapability !== undefined ? { deniedCapability } : {}),
  } as const);

const downgrade = (
  rewrittenEffect: Effect,
  diagnostic: DiagnosticEffect,
): EnforcementResult =>
  Object.freeze({
    kind: "downgrade",
    rewrittenEffect,
    diagnostic,
  } as const);

// ----- enforceCapability ----------------------------------------------------

/**
 * The single enforcement entry point. Pure: same `(effect, declared,
 * granted)` triple always produces the same result.
 *
 * Routing per docs/wiki/matrices/effect-x-capability.md:
 *   - patch      → `patch.auto` (with auto→propose downgrade) / `patch.propose`
 *   - diagnostic → always allow
 *   - fact       → `graph.write` matching the predicate's namespace
 *   - search-document → `search.write` matching the document path
 *   - question   → `question.ask`
 *   - job        → `job.enqueue` matching the target processor id
 *   - external   → `external:<capability>` matching effect's `capability`
 *   - outbox-recovery → `outbox.recover` matching effect's action
 *   - quarantine-recovery → `quarantine.recover` matching effect's action
 *   - run-recovery → `run.recover` matching effect's action
 *   - view       → always allow at this layer (phase check lives elsewhere)
 */
export function enforceCapability(
  effect: Effect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const kindVerdict = enforceEffectKindCapability(effect, declared, granted);
  if (kindVerdict.kind === "deny") return kindVerdict;

  const sourceRefsVerdict = enforceSourceRefRead(effect, declared, granted);
  if (sourceRefsVerdict.kind === "deny") return sourceRefsVerdict;

  return kindVerdict;
}

function enforceEffectKindCapability(
  effect: Effect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  switch (effect.kind) {
    case "patch":
      return enforcePatch(effect, declared, granted);
    case "diagnostic":
      return allow();
    case "fact":
      return enforceFact(effect, declared, granted);
    case "search-document":
      return enforceSearchDocument(effect, declared, granted);
    case "question":
      return enforceQuestion(declared, granted);
    case "job":
      return enforceJob(effect, declared, granted);
    case "external":
      return enforceExternal(effect, declared, granted);
    case "outbox-recovery":
      return enforceOutboxRecovery(effect, declared, granted);
    case "quarantine-recovery":
      return enforceQuarantineRecovery(effect, declared, granted);
    case "run-recovery":
      return enforceRunRecovery(effect, declared, granted);
    case "view":
      return allow();
  }
  // Exhaustive switch — TS verifies via the `never` exhaustiveness check.
  // Adding an Effect kind here is a compile error until every
  // branch above is updated.
  const _exhaustive: never = effect;
  return _exhaustive;
}

function enforceSourceRefRead(
  effect: Effect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  for (const ref of sourceRefsForReadCheck(effect)) {
    if (readablePath(ref.path, declared, granted) === null) {
      return deny(
        diagnosticEffect({
          severity: "error",
          code: "capability-deny-source-ref-read",
          message:
            `Effect denied: sourceRef path '${ref.path}' has no effective ` +
            "'read' grant. Use ctx.sourceRef(...) only for readable paths, " +
            "or declare and grant read access for the referenced evidence.",
          sourceRefs: [],
        }),
        Object.freeze({
          capability: "read",
          resource: ref.path,
        }),
      );
    }
  }
  return allow();
}

function sourceRefsForReadCheck(effect: Effect): ReadonlyArray<SourceRef> {
  switch (effect.kind) {
    case "patch":
    case "diagnostic":
    case "fact":
    case "search-document":
    case "question":
    case "external":
      return effect.sourceRefs;
    case "view":
      return effect.scope;
    case "job":
    case "outbox-recovery":
    case "quarantine-recovery":
    case "run-recovery":
      return [];
  }
  const _exhaustive: never = effect;
  return _exhaustive;
}

// ----- PatchEffect enforcement ---------------------------------------------

/**
 * PatchEffect enforcement. Steps (per the matrix):
 *
 *   1. Extract the unique touched paths from `effect.changes`.
 *   2. If a third party owns any path (any `owns.path` grant whose pattern
 *      matches, but not declared by this processor), deny.
 *   3. For `mode: "auto"`:
 *      - If `patch.auto` is effective for every path → allow.
 *      - Else if `patch.propose` is effective for every path → downgrade.
 *      - Else → deny.
 *   4. For `mode: "propose"`:
 *      - If `patch.propose` is effective for every path → allow.
 *      - Else → deny.
 *
 * `owns.region` is rejected in v1 because region ownership cannot be
 * enforced until the patch boundary can parse marker-delimited regions.
 */
function enforcePatch(
  effect: PatchEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const paths = uniqueChangedPaths(effect);
  if (paths.length === 0) {
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-patch",
        message:
          "PatchEffect denied: `changes` is empty; the broker cannot determine the touched paths. A PatchEffect must carry at least one FileChange (this is also enforced by PatchEffectSchema).",
        sourceRefs: [],
      }),
    );
  }

  if (
    hasCapabilityKind(declared, "owns.region") ||
    hasCapabilityKind(granted, "owns.region")
  ) {
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-patch",
        message:
          "PatchEffect denied: 'owns.region' is planned but not supported in v1. Use 'owns.path' or path-scoped patch grants until generated-region ownership enforcement ships.",
        sourceRefs: [],
      }),
    );
  }

  // owns.path: if a granted owns.path covers any touched path and the
  // emitting processor does NOT declare the same owns.path coverage, the
  // patch is reaching into another processor's territory. Deny.
  for (const path of paths) {
    if (pathIsOwnedByThirdParty(path, declared, granted)) {
      return deny(
        diagnosticEffect({
          severity: "error",
          code: "capability-deny-patch",
          message: `PatchEffect denied: path '${path}' is owned by another processor via 'owns.path'. Only the owning processor may emit patches against an owned path; declare 'owns.path' in the manifest and grant it in config.yaml if this processor should own the file.`,
          sourceRefs: [],
        }),
      );
    }
  }

  if (effect.mode === "auto") {
    if (
      paths.every((path) =>
        pathCapabilityEffectiveFor("patch.auto", path, declared, granted)
      )
    ) {
      return allow();
    }
    const missingAutoPath = paths.find(
      (path) =>
        !pathCapabilityEffectiveFor("patch.auto", path, declared, granted),
    );
    if (
      paths.every((path) =>
        pathCapabilityEffectiveFor("patch.propose", path, declared, granted)
      )
    ) {
      const rewritten: PatchEffect = patchEffect({
        mode: "propose",
        changes: effect.changes,
        reason: effect.reason,
        sourceRefs: effect.sourceRefs,
      });
      return downgrade(
        rewritten,
        diagnosticEffect({
          severity: "warning",
          code: "capability-downgrade-surprise",
          message: `PatchEffect downgraded from 'auto' to 'propose': path '${missingAutoPath ?? paths[0]}' has no effective 'patch.auto' grant. Every changed path must have effective 'patch.auto' to keep auto-apply.`,
          sourceRefs: [],
        }),
      );
    }
    const missingPatchPath = paths.find(
      (path) =>
        !pathCapabilityEffectiveFor("patch.auto", path, declared, granted) &&
        !pathCapabilityEffectiveFor("patch.propose", path, declared, granted),
    );
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-patch",
        message: `PatchEffect denied: path '${missingPatchPath ?? paths[0]}' has no effective 'patch.auto' or 'patch.propose' grant. Every changed path must have an effective patch grant before one PatchEffect can proceed.`,
        sourceRefs: [],
      }),
    );
  }

  // mode === "propose"
  if (
    paths.every((path) =>
      pathCapabilityEffectiveFor("patch.propose", path, declared, granted)
    )
  ) {
    return allow();
  }
  const missingProposePath = paths.find(
    (path) =>
      !pathCapabilityEffectiveFor("patch.propose", path, declared, granted),
  );
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-patch",
      message: `PatchEffect denied: path '${missingProposePath ?? paths[0]}' has no effective 'patch.propose' grant. Every changed path must have an effective 'patch.propose' grant.`,
      sourceRefs: [],
    }),
  );
}

function hasCapabilityKind(
  capabilities: ReadonlyArray<Capability>,
  kind: Capability["kind"],
): boolean {
  return capabilities.some((capability) => capability.kind === kind);
}

function uniqueChangedPaths(effect: PatchEffect): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const change of effect.changes) {
    paths.add(change.path);
  }
  return Object.freeze([...paths]);
}

// ----- FactEffect enforcement ----------------------------------------------

/**
 * FactEffect requires a `graph.write` grant whose namespace list covers the
 * predicate's namespace (the dotted prefix before the last segment).
 */
function enforceFact(
  effect: FactEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const namespace = predicateNamespace(effect.predicate);
  if (namespace === null) {
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-graph-write",
        message: `FactEffect denied: predicate '${effect.predicate}' has no namespace (expected '<namespace>.<key>'). Use a dotted predicate like 'dome.tasks.dueDate'.`,
        sourceRefs: [],
      }),
    );
  }
  if (namespaceEffectiveFor(namespace, declared, granted)) {
    return allow();
  }
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-graph-write",
      message: `FactEffect denied: predicate '${effect.predicate}' (namespace '${namespace}') has no effective 'graph.write' grant. Declare 'graph.write' with namespace '${namespace}' in the manifest and grant it in config.yaml.`,
      sourceRefs: [],
    }),
  );
}

// ----- SearchDocumentEffect enforcement ------------------------------------

/**
 * SearchDocumentEffect requires a `search.write` grant matching the indexed
 * document path. This keeps FTS rows behind path-scoped capability
 * discipline instead of letting search processors write SQLite directly.
 */
function enforceSearchDocument(
  effect: SearchDocumentEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  if (pathCapabilityEffectiveFor("search.write", effect.path, declared, granted)) {
    return allow();
  }
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-search-write",
      message: `SearchDocumentEffect denied: path '${effect.path}' has no effective 'search.write' grant. Declare 'search.write' for indexed paths in the manifest and grant it in config.yaml.`,
      sourceRefs: [],
    }),
  );
}

// ----- QuestionEffect enforcement ------------------------------------------

/**
 * QuestionEffect requires an explicit `question.ask` grant. In v1 this is a
 * binary capability: QuestionEffect has no namespace/channel field, so the
 * manifest/config surface does not pretend to expose narrower scopes.
 */
function enforceQuestion(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const hasDeclared = declared.some((c) => c.kind === "question.ask");
  const hasGranted = granted.some((c) => c.kind === "question.ask");
  if (hasDeclared && hasGranted) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-question-ask",
      message:
        "QuestionEffect denied: no effective 'question.ask' grant. Declare 'question.ask' in the manifest and grant it in config.yaml.",
      sourceRefs: [],
    }),
  );
}

// ----- JobEffect enforcement ------------------------------------------------

/**
 * JobEffect requires a `job.enqueue` grant whose processor patterns cover
 * the target processor id.
 */
function enforceJob(
  effect: JobEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  if (processorEffectiveFor(effect.processorId, declared, granted)) {
    return allow();
  }
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-job-enqueue",
      message: `JobEffect denied: target processor '${effect.processorId}' has no effective 'job.enqueue' grant. Declare 'job.enqueue' with a matching processor id or glob and grant it in config.yaml.`,
      sourceRefs: [],
    }),
  );
}

// ----- ExternalActionEffect enforcement ------------------------------------

/**
 * ExternalActionEffect requires an `external` capability whose `capability`
 * field matches the effect's `capability` exactly (each external capability
 * is a separate grant per capabilities.md §"external").
 */
function enforceExternal(
  effect: ExternalActionEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const hasDeclared = declared.some(
    (c) => c.kind === "external" && c.capability === effect.capability,
  );
  const hasGranted = granted.some(
    (c) => c.kind === "external" && c.capability === effect.capability,
  );
  if (hasDeclared && hasGranted) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-external",
      message: `ExternalActionEffect denied: capability '${effect.capability}' has no effective 'external' grant. Declare 'external: ${effect.capability}' in the manifest and grant it in config.yaml.`,
      sourceRefs: [],
    }),
  );
}

// ----- OutboxRecoveryEffect enforcement ------------------------------------

function enforceOutboxRecovery(
  effect: OutboxRecoveryEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const hasDeclared = declared.some(
    (c) => c.kind === "outbox.recover" && c.actions.includes(effect.action),
  );
  const hasGranted = granted.some(
    (c) => c.kind === "outbox.recover" && c.actions.includes(effect.action),
  );
  if (hasDeclared && hasGranted) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-outbox-recover",
      message: `OutboxRecoveryEffect denied: action '${effect.action}' has no effective 'outbox.recover' grant.`,
      sourceRefs: [],
    }),
  );
}

// ----- QuarantineRecoveryEffect enforcement --------------------------------

function enforceQuarantineRecovery(
  effect: QuarantineRecoveryEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const hasDeclared = declared.some(
    (c) => c.kind === "quarantine.recover" && c.actions.includes(effect.action),
  );
  const hasGranted = granted.some(
    (c) => c.kind === "quarantine.recover" && c.actions.includes(effect.action),
  );
  if (hasDeclared && hasGranted) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-quarantine-recover",
      message: `QuarantineRecoveryEffect denied: action '${effect.action}' has no effective 'quarantine.recover' grant.`,
      sourceRefs: [],
    }),
  );
}

// ----- RunRecoveryEffect enforcement ---------------------------------------

function enforceRunRecovery(
  effect: RunRecoveryEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const hasDeclared = declared.some(
    (c) => c.kind === "run.recover" && c.actions.includes(effect.action),
  );
  const hasGranted = granted.some(
    (c) => c.kind === "run.recover" && c.actions.includes(effect.action),
  );
  if (hasDeclared && hasGranted) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-run-recover",
      message: `RunRecoveryEffect denied: action '${effect.action}' has no effective 'run.recover' grant.`,
      sourceRefs: [],
    }),
  );
}

// ----- Processor-id / glob helpers -----------------------------------------

function processorEffectiveFor(
  processorId: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  return (
    anyProcessorCapabilityMatches(processorId, declared) &&
    anyProcessorCapabilityMatches(processorId, granted)
  );
}

function anyProcessorCapabilityMatches(
  processorId: string,
  caps: ReadonlyArray<Capability>,
): boolean {
  for (const cap of caps) {
    if (cap.kind !== "job.enqueue") continue;
    for (const pattern of cap.processors) {
      if (globMatch(pattern, processorId)) return true;
    }
  }
  return false;
}

// ----- Namespace helpers ----------------------------------------------------

/**
 * Extract the namespace prefix of a predicate. The predicate is
 * `<namespace>.<key>` per capabilities.md §"graph.write"; the namespace is
 * everything before the *last* `.`. Returns `null` for a predicate with no
 * dot (no namespace).
 */
function predicateNamespace(predicate: string): string | null {
  const lastDot = predicate.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return predicate.slice(0, lastDot);
}

/**
 * A namespace is *effective* iff at least one declared `graph.write`
 * capability's namespace list covers it AND at least one granted
 * `graph.write` capability's namespace list covers it.
 *
 * A capability namespace `N` covers a predicate-namespace `P` when:
 *   - `N === P` (exact match), OR
 *   - `N` ends with `.*` and `P === stripStar(N)` or `P.startsWith(stripStar(N) + ".")` (wildcard match), OR
 *   - `P.startsWith(N + ".")` (P is a sub-namespace of N).
 *
 * The `.*` form is supported because capabilities.md §"graph.write" shows
 * `graph.write: ["dome.tasks.*"]` in its narrative example. v1 namespace
 * coverage is read as "this prefix and everything beneath it."
 */
function namespaceEffectiveFor(
  namespace: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  return (
    anyNamespaceCovers(namespace, declared) &&
    anyNamespaceCovers(namespace, granted)
  );
}

function anyNamespaceCovers(
  predicateNs: string,
  caps: ReadonlyArray<Capability>,
): boolean {
  for (const cap of caps) {
    if (cap.kind !== "graph.write") continue;
    for (const declaredNs of cap.namespaces) {
      if (namespaceCovers(declaredNs, predicateNs)) return true;
    }
  }
  return false;
}

function namespaceCovers(declaredNs: string, predicateNs: string): boolean {
  if (declaredNs.length === 0 || predicateNs.length === 0) return false;
  const stripped = declaredNs.endsWith(".*")
    ? declaredNs.slice(0, -2)
    : declaredNs;
  if (stripped === predicateNs) return true;
  return predicateNs.startsWith(`${stripped}.`);
}
