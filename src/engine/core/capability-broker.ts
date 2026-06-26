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
// `src/engine/core/apply-effect.ts` (Phase 2.x), which is the only call site per
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
//   - `owns.path` is enforced here: a path-bearing PatchEffect targeting a
//     path matched by a granted `owns.path` capability that the emitting
//     processor's declared capabilities do not include is denied with a
//     `capability-deny-patch` diagnostic.
//   - `raw/**` is immutable: any PatchEffect touching a raw path is denied
//     regardless of declared/granted path reach. Direct user commits that mutate
//     raw files are blocked separately by `dome.markdown.raw-immutable`.
//   - Content/user-visible SourceRefs are broker-checked against the
//     processor's effective `read` grant after the effect-kind-specific
//     capability check succeeds. This prevents processors from bypassing
//     the scoped `ctx.sourceRef()` helper by importing the raw constructor.
//
// House-style notes (matches src/core/source-ref.ts,
// src/core/effect.ts, src/engine/core/compile-range.ts):
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
} from "../../core/effect";
import { diagnosticEffect, patchEffect } from "../../core/effect";
import type { Capability } from "../../core/processor";
import type { SourceRef } from "../../core/source-ref";
import {
  pathCapabilityEffectiveFor,
  pathIsOwnedByThirdParty,
  readablePath,
} from "./path-capabilities";
import { globMatch } from "./glob-cache";
import { predicateNamespace } from "./effect-capability-use";

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

// ----- effective-grant matching ---------------------------------------------

/**
 * The effective-grant invariant, in one place: a capability is effective only
 * when at least one capability satisfying `match` is BOTH declared (manifest)
 * AND granted (config.yaml). Every per-kind enforcement reduces to a `match`
 * predicate over this AND. Keeping the `&&` singular means a declared-XOR-
 * granted slip can never silently allow an effect.
 */
function effective(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
  match: (capability: Capability) => boolean,
): boolean {
  return declared.some(match) && granted.some(match);
}

/**
 * Allow when `match` is effective across declared+granted; otherwise deny with
 * the given diagnostic. The shared shape behind the per-kind enforcers whose
 * only variation is the match predicate and the deny code/message.
 */
function enforceGrant(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
  match: (capability: Capability) => boolean,
  denyDiagnostic: { readonly code: string; readonly message: string },
): EnforcementResult {
  if (effective(declared, granted, match)) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: denyDiagnostic.code,
      message: denyDiagnostic.message,
      sourceRefs: [],
    }),
  );
}

/**
 * The three recovery effects share an identical enforcement shape: a
 * `<area>.recover` grant whose `actions` list covers the effect's action. The
 * only variation is the capability kind (typed to the recover-capability union)
 * and the templated deny message. The dispatch switch pairs each recovery
 * effect kind with its `capKind`, so the action sets correspond.
 */
function enforceRecovery(
  effect: OutboxRecoveryEffect | QuarantineRecoveryEffect | RunRecoveryEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
  capKind: "outbox.recover" | "quarantine.recover" | "run.recover",
  effectName: string,
): EnforcementResult {
  return enforceGrant(
    declared,
    granted,
    (c) =>
      c.kind === capKind &&
      (c.actions as ReadonlyArray<string>).includes(effect.action),
    {
      code: `capability-deny-${capKind.replace(".", "-")}`,
      message: `${effectName} denied: action '${effect.action}' has no effective '${capKind}' grant.`,
    },
  );
}

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
      return enforceRecovery(
        effect,
        declared,
        granted,
        "outbox.recover",
        "OutboxRecoveryEffect",
      );
    case "quarantine-recovery":
      return enforceRecovery(
        effect,
        declared,
        granted,
        "quarantine.recover",
        "QuarantineRecoveryEffect",
      );
    case "run-recovery":
      return enforceRecovery(
        effect,
        declared,
        granted,
        "run.recover",
        "RunRecoveryEffect",
      );
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
 *   2. Deny `raw/**` unconditionally. Raw sources are immutable.
 *   3. If a third party owns any path (any `owns.path` grant whose pattern
 *      matches, but not declared by this processor), deny.
 *   4. For `mode: "auto"`:
 *      - If `patch.auto` is effective for every path → allow.
 *      - Else if `patch.propose` is effective for every path → downgrade.
 *      - Else → deny.
 *   5. For `mode: "propose"`:
 *      - If `patch.propose` is effective for every path → allow.
 *      - Else → deny.
 *
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

  const rawPath = paths.find(isRawPath);
  if (rawPath !== undefined) {
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-patch",
        message:
          `PatchEffect denied: raw/ is immutable; processors cannot patch '${rawPath}'. ` +
          "Create derived wiki pages or inbox archives instead of mutating raw evidence.",
        sourceRefs: [],
      }),
      Object.freeze({
        capability: effect.mode === "auto" ? "patch.auto" : "patch.propose",
        resource: rawPath,
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

function uniqueChangedPaths(effect: PatchEffect): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const change of effect.changes) {
    paths.add(change.path);
  }
  return Object.freeze([...paths]);
}

function isRawPath(path: string): boolean {
  return path === "raw" || path.startsWith("raw/");
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
  return enforceGrant(
    declared,
    granted,
    (c) => c.kind === "question.ask",
    {
      code: "capability-deny-question-ask",
      message:
        "QuestionEffect denied: no effective 'question.ask' grant. Declare 'question.ask' in the manifest and grant it in config.yaml.",
    },
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
  return enforceGrant(
    declared,
    granted,
    (c) => c.kind === "external" && c.capability === effect.capability,
    {
      code: "capability-deny-external",
      message: `ExternalActionEffect denied: capability '${effect.capability}' has no effective 'external' grant. Declare 'external: ${effect.capability}' in the manifest and grant it in config.yaml.`,
    },
  );
}

// ----- Processor-id / glob helpers -----------------------------------------

function processorEffectiveFor(
  processorId: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  return effective(declared, granted, (c) =>
    jobEnqueueCovers(c, processorId),
  );
}

function jobEnqueueCovers(
  capability: Capability,
  processorId: string,
): boolean {
  return (
    capability.kind === "job.enqueue" &&
    capability.processors.some((pattern) => globMatch(pattern, processorId))
  );
}

// ----- Namespace helpers ----------------------------------------------------

/**
 * True when at least one `graph.write` capability in `caps` covers
 * `predicate`'s namespace. Exported for `dome doctor`'s grant-entry probes
 * (src/engine/host/health.ts) so health checks and broker enforcement share one
 * namespace matcher and cannot drift.
 */
export function graphWriteCovers(
  predicate: string,
  caps: ReadonlyArray<Capability>,
): boolean {
  const namespace = predicateNamespace(predicate);
  if (namespace === null) return false;
  return anyNamespaceCovers(namespace, caps);
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
  return effective(declared, granted, (c) =>
    graphWriteNamespaceCovers(c, namespace),
  );
}

// Single-list namespace coverage, kept for the exported `graphWriteCovers`
// (consumed by `dome doctor`); shares the per-capability predicate with
// `namespaceEffectiveFor` so the two cannot drift.
function anyNamespaceCovers(
  predicateNs: string,
  caps: ReadonlyArray<Capability>,
): boolean {
  return caps.some((c) => graphWriteNamespaceCovers(c, predicateNs));
}

function graphWriteNamespaceCovers(
  capability: Capability,
  namespace: string,
): boolean {
  return (
    capability.kind === "graph.write" &&
    capability.namespaces.some((declaredNs) =>
      namespaceCovers(declaredNs, namespace),
    )
  );
}

function namespaceCovers(declaredNs: string, predicateNs: string): boolean {
  if (declaredNs.length === 0 || predicateNs.length === 0) return false;
  const stripped = declaredNs.endsWith(".*")
    ? declaredNs.slice(0, -2)
    : declaredNs;
  if (stripped === predicateNs) return true;
  return predicateNs.startsWith(`${stripped}.`);
}
