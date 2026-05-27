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
// v1 Phase 2 limitations (documented for downstream phases):
//   - PatchEffect path extraction uses the first non-empty line beginning
//     with `+++` or `---` in the patch text as a single representative
//     path. A future Phase 2.x patch parser will enumerate every path
//     touched by every hunk and enforce per-path. If the patch has no
//     recognizable header, enforcement denies with a diagnostic naming the
//     malformed patch.
//   - `owns.region` detection is deferred to Phase 6 (the `dome.markdown`
//     region parser produces region ids from marker pairs in the candidate
//     tree). For now the broker falls through to the regular
//     `patch.auto` / `patch.propose` check rather than enforcing region
//     ownership; Phase 6 will plumb a region-parser callback through
//     `enforcePatch`. `owns.path` is enforced here: a path-bearing
//     PatchEffect targeting a path matched by a granted `owns.path`
//     capability that the emitting processor's declared capabilities do
//     not include is denied with a `capability-deny-patch` diagnostic.
//
// House-style notes (matches src/core/source-ref.ts,
// src/core/effect.ts, src/engine/compile-range.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Exhaustive `switch` on `Effect.kind` with a `never`-typed catch-all
//     so adding an eighth Effect kind is a compile error here.
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
  PatchEffect,
} from "../core/effect";
import { diagnosticEffect, patchEffect } from "../core/effect";
import type { Capability } from "../core/processor";

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
    };

/** Frozen singleton for the common case — avoid per-call allocation. */
const ALLOW: EnforcementResult = Object.freeze({ kind: "allow" } as const);

const allow = (): EnforcementResult => ALLOW;

const deny = (diagnostic: DiagnosticEffect): EnforcementResult =>
  Object.freeze({ kind: "deny", diagnostic } as const);

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
 *   - question   → any `graph.write` (implicit)
 *   - job        → implicit grant in v1 (cross-bundle scoping deferred)
 *   - external   → `external:<capability>` matching effect's `capability`
 *   - view       → always allow at this layer (phase check lives elsewhere)
 */
export function enforceCapability(
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
    case "question":
      return enforceQuestion(declared, granted);
    case "job":
      // v1 lenient: cross-bundle JobEffect routing is permissive; future
      // `job.enqueue` grant scoping lives at the routing layer, not here.
      return allow();
    case "external":
      return enforceExternal(effect, declared, granted);
    case "view":
      return allow();
  }
  // Exhaustive switch — TS verifies via the `never` exhaustiveness check.
  // Adding an eighth Effect kind here is a compile error until every
  // branch above is updated.
  const _exhaustive: never = effect;
  return _exhaustive;
}

// ----- PatchEffect enforcement ---------------------------------------------

/**
 * PatchEffect enforcement. Steps (per the matrix):
 *
 *   1. Extract the representative touched path from the patch text (v1
 *      limitation: first +++/--- header line).
 *   2. If a third party owns the path (any `owns.path` grant whose pattern
 *      matches, but not declared by this processor), deny.
 *   3. For `mode: "auto"`:
 *      - If `patch.auto` is effective for the path → allow.
 *      - Else if `patch.propose` is effective for the path → downgrade.
 *      - Else → deny.
 *   4. For `mode: "propose"`:
 *      - If `patch.propose` is effective for the path → allow.
 *      - Else → deny.
 *
 * `owns.region` enforcement is deferred (Phase 6 region parser); the
 * broker falls through to the auto/propose check.
 */
function enforcePatch(
  effect: PatchEffect,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const path = extractRepresentativePath(effect.patch);
  if (path === null) {
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-patch",
        message:
          "PatchEffect denied: patch text has no `+++` or `---` header line; the v1 broker cannot determine the touched path. Ensure the patch is a well-formed unified diff.",
        sourceRefs: [],
      }),
    );
  }

  // Phase 2 limitation: `owns.region` verification (matching patch hunks
  // against marker-delimited regions in the candidate tree) is deferred to
  // Phase 6's region parser. The broker currently falls through to the
  // patch.auto / patch.propose check without enforcing region ownership;
  // the result discriminator only carries one diagnostic per verdict, so
  // the limitation is documented in the file banner rather than surfaced
  // per-call. Downstream Phase 6 will plumb a region-parser callback
  // through this function.

  // owns.path: if a granted owns.path covers the touched path and the
  // emitting processor does NOT declare the same owns.path coverage, the
  // patch is reaching into another processor's territory. Deny.
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

  if (effect.mode === "auto") {
    if (pathEffectiveFor("patch.auto", path, declared, granted)) {
      return allow();
    }
    if (pathEffectiveFor("patch.propose", path, declared, granted)) {
      const rewritten: PatchEffect = patchEffect({
        mode: "propose",
        patch: effect.patch,
        reason: effect.reason,
        sourceRefs: effect.sourceRefs,
      });
      return downgrade(
        rewritten,
        diagnosticEffect({
          severity: "warning",
          code: "capability-downgrade-surprise",
          message: `PatchEffect downgraded from 'auto' to 'propose' for path '${path}': no effective 'patch.auto' grant matches this path. Declare 'patch.auto' for this path in the manifest and grant it in config.yaml to keep auto-apply.`,
          sourceRefs: [],
        }),
      );
    }
    return deny(
      diagnosticEffect({
        severity: "error",
        code: "capability-deny-patch",
        message: `PatchEffect denied: path '${path}' has no effective 'patch.auto' or 'patch.propose' grant. Declare 'patch.propose' in the manifest and grant it in config.yaml to emit propose-mode patches against this path.`,
        sourceRefs: [],
      }),
    );
  }

  // mode === "propose"
  if (pathEffectiveFor("patch.propose", path, declared, granted)) {
    return allow();
  }
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-patch",
      message: `PatchEffect denied: path '${path}' has no effective 'patch.propose' grant. Declare 'patch.propose' in the manifest and grant it in config.yaml.`,
      sourceRefs: [],
    }),
  );
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

// ----- QuestionEffect enforcement ------------------------------------------

/**
 * QuestionEffect requires *any* `graph.write` grant (implicit per the
 * matrix: a processor that writes to the graph at all may ask questions).
 */
function enforceQuestion(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EnforcementResult {
  const hasDeclared = declared.some((c) => c.kind === "graph.write");
  const hasGranted = granted.some((c) => c.kind === "graph.write");
  if (hasDeclared && hasGranted) return allow();
  return deny(
    diagnosticEffect({
      severity: "error",
      code: "capability-deny-graph-write",
      message:
        "QuestionEffect denied: no effective 'graph.write' grant of any namespace. Declare 'graph.write' in the manifest and grant it in config.yaml.",
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

// ----- Path / glob helpers -------------------------------------------------

/**
 * A path is *effective* for a path-bearing capability kind iff at least one
 * declared capability of that kind has a pattern matching the path AND at
 * least one granted capability of the same kind has a pattern matching the
 * path. This is the per-path intersection of declared and granted.
 */
function pathEffectiveFor(
  kind: "patch.auto" | "patch.propose" | "owns.path" | "read",
  path: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  return (
    anyPathCapabilityMatches(kind, path, declared) &&
    anyPathCapabilityMatches(kind, path, granted)
  );
}

function anyPathCapabilityMatches(
  kind: "patch.auto" | "patch.propose" | "owns.path" | "read",
  path: string,
  caps: ReadonlyArray<Capability>,
): boolean {
  for (const cap of caps) {
    // The four path-bearing capability kinds all share the same `paths`
    // field shape; narrow on each kind individually so TS picks up the
    // discriminator. (A loose `cap.kind !== kind` against a non-singleton
    // `kind` parameter does not narrow the union.)
    if (
      cap.kind === "patch.auto" ||
      cap.kind === "patch.propose" ||
      cap.kind === "owns.path" ||
      cap.kind === "read"
    ) {
      if (cap.kind !== kind) continue;
      for (const pattern of cap.paths) {
        if (globMatch(pattern, path)) return true;
      }
    }
  }
  return false;
}

/**
 * `owns.path` third-party detection: the path is owned by another processor
 * if some *granted* `owns.path` capability matches the path while the
 * emitting processor's *declared* capabilities include no `owns.path`
 * covering this path. The granted set encodes the policy ("dome.index owns
 * index.md"); declared encodes what this processor claims to own. A
 * processor patching `index.md` without declaring `owns.path: ["index.md"]`
 * is reaching into another processor's territory.
 */
function pathIsOwnedByThirdParty(
  path: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  const ownedByPolicy = anyPathCapabilityMatches("owns.path", path, granted);
  if (!ownedByPolicy) return false;
  const declaredOwn = anyPathCapabilityMatches("owns.path", path, declared);
  return !declaredOwn;
}

/**
 * Path-glob match using Bun's built-in glob matcher. Per
 * docs/wiki/matrices/effect-x-capability.md §"Capability lookup
 * performance" the SDK uses `new Bun.Glob(pattern).match(path)`; v1 calls
 * the matcher directly (the future bundle loader will cache compiled Glob
 * instances per pattern).
 *
 * The matcher is tolerant of empty patterns (returns false) and empty
 * paths (returns false). Path strings are POSIX-style vault-relative.
 */
function globMatch(pattern: string, path: string): boolean {
  if (pattern.length === 0 || path.length === 0) return false;
  // Exact-string fast path — avoids constructing a Glob for the common
  // case of a literal path in an `owns.path` grant.
  if (pattern === path) return true;
  return new Bun.Glob(pattern).match(path);
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

// ----- Patch path extraction (v1 limitation) -------------------------------

/**
 * Extract a single representative path from a unified-diff patch text.
 * v1 limitation per the file banner: returns the first non-empty header
 * line beginning with `+++` or `---`, stripped of the leading marker, the
 * tab/space separator, and any `a/` or `b/` directory prefix git emits.
 *
 * Returns `null` if no recognizable header is found. Lines like
 * `--- /dev/null` (file creation) and `+++ /dev/null` (file deletion) are
 * skipped; the broker continues scanning until a real path is found.
 */
function extractRepresentativePath(patch: string): string | null {
  // Split on `\n`; tolerate `\r\n` by trimming trailing `\r` per line.
  const lines = patch.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const isMinus = line.startsWith("--- ");
    const isPlus = line.startsWith("+++ ");
    if (!isMinus && !isPlus) continue;
    const rest = line.slice(4).trim();
    if (rest.length === 0) continue;
    if (rest === "/dev/null") continue;
    // Strip `a/` (in `---` headers) or `b/` (in `+++` headers) prefix git
    // conventionally emits. Don't strip arbitrary single-char prefixes —
    // only the two git uses.
    const stripped =
      (isMinus && rest.startsWith("a/")) || (isPlus && rest.startsWith("b/"))
        ? rest.slice(2)
        : rest;
    if (stripped.length === 0) continue;
    return stripped;
  }
  return null;
}
