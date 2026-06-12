---
type: matrix
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Maps each Effect kind to the broker-required capability, its resource scope, and the denial or downgrade outcome when the grant is missing.
---

# Effect × capability matrix

Per-Effect-kind capability requirements enforced by the broker at the engine routing boundary. Generic routes go through `apply-effect.ts`; garden PatchEffects go through `garden-patch-dispatch.ts` because their destination is sub-Proposal construction. The broker rejects effects emitted without the required capability; `tests/engine/capability-broker.test.ts`, `tests/engine/apply-effect.test.ts`, and `tests/engine/garden-patch-router.test.ts` exercise the matrix at the broker and routing boundaries.

## The matrix

| Effect kind ↓ \ Capability requirement → | Required capability | Resource scope | Outcome on denial |
|---|---|---|---|
| **PatchEffect (mode: "auto")** | `patch.auto` | every path touched by the patch must be matched by the grant's glob list | Downgraded to `mode: "propose"` with a `capability-downgrade-surprise` diagnostic |
| **PatchEffect (mode: "propose")** | `patch.propose` | every path touched by the patch | Denied; diagnostic emitted; effect discarded |
| **PatchEffect (touching owned region)** | Planned `owns.region`; rejected in v1 manifests/config until parser-backed enforcement ships | per-region check via marker parsing | V1 denies any hand-built PatchEffect route that carries `owns.region` rather than pretending to enforce it |
| **PatchEffect (touching owned path)** | `owns.path` for each modified path, OR the patch must touch only non-owned paths | per-path check against `owns.path` grants in vault config | Denied unless the emitting processor is the path's owner |
| **PatchEffect (touching `raw/**`)** | none; raw paths are ungrantable write territory | path prefix `raw/` | Denied with `capability-deny-patch`; raw sources are immutable |
| **DiagnosticEffect (any severity)** | (none — every processor may emit diagnostics) | — | (n/a — no denial path) |
| **FactEffect** | `graph.write` matching the namespace prefix of `predicate` | predicate `<namespace>.<key>` → namespace must be in the grant list | Denied; diagnostic with `code: capability-deny-graph-write`; effect discarded |
| **SearchDocumentEffect** | `search.write` | indexed/deleted document path must match the grant's glob list | Denied; diagnostic with `code: capability-deny-search-write`; effect discarded |
| **QuestionEffect** | `question.ask` | binary in v1; future scoped questions need an explicit effect field first | Denied; diagnostic with `code: capability-deny-question-ask`; effect discarded |
| **JobEffect** | `job.enqueue` | target processor id or bundle-level glob | Denied; diagnostic with `code: capability-deny-job-enqueue`; effect discarded |
| **ExternalActionEffect** | `external:<capability>` matching the effect's `capability` field | per-capability (e.g., `external: ["calendar.write"]` authorizes `capability: "calendar.write"`) | Denied; diagnostic with `code: capability-deny-external`; effect discarded |
| **OutboxRecoveryEffect** | `outbox.recover` | requested action (`retry` or `abandon`) | Denied; diagnostic with `code: capability-deny-outbox-recover`; effect discarded |
| **QuarantineRecoveryEffect** | `quarantine.recover` | requested action (`reset`) | Denied; diagnostic with `code: capability-deny-quarantine-recover`; effect discarded |
| **RunRecoveryEffect** | `run.recover` | requested action (`fail`) | Denied; diagnostic with `code: capability-deny-run-recover`; effect discarded |
| **ViewEffect** | (none at capability layer — phase check rejects view effects from non-view processors) | — | (n/a at capability layer; phase mismatch at the routing layer per [[wiki/matrices/effect-router-targets]]) |

## Downgrade vs denial

The broker has three outcomes per [[wiki/specs/capabilities]] §"Enforcement chokepoint":

- **Allow** — capability matched; effect applied as-is.
- **Downgrade** — capability for the requested mode not granted, but a lesser mode would be authorized. Rewrites the effect; applies the downgraded version. Emits a diagnostic naming the original mode and the downgrade.
- **Deny** — no capability matches; effect discarded; diagnostic emitted.

Downgrade is currently used for one case: PatchEffect `mode: "auto"` → `mode: "propose"` when the processor has `patch.propose` but not `patch.auto` for the touched paths. Other effects deny rather than downgrade.

## Cross-bundle invocations

A processor in bundle A that emits a `JobEffect { processorId: "B:foo" }` invokes a processor in bundle B. The broker checks bundle A's capability set for `job.enqueue` and requires the target processor id to match one of the granted `processors` entries.

Same-bundle enqueue can be shipped as a default grant for first-party bundles, but it is still explicit in the effective capability set. Cross-bundle enqueue requires a grant such as `job.enqueue: ["B:*"]`.

## Capability lookup performance

The broker's `enforceCapability` is hot — runs once per emitted effect, every adoption iteration, every garden run, every view request. Implementation notes:

- Path glob matching uses Bun's built-in glob matcher (`new Bun.Glob(pattern)`); compiled once at bundle load and cached.
- Namespace prefix matching is string prefix comparison (no regex).
- The grant set is precomputed at `openVault` time (the intersection of manifest capabilities and config grants); each enforcement call is O(num-grants) — typically <20 grants per processor.

Per-call cost is sub-millisecond; the broker is not the engine's bottleneck.

## Why `model.invoke` is missing from this matrix

`model.invoke` is checked at a different chokepoint — when a processor calls `ctx.modelInvoke(...)`, the model-invoke shim consults the effective processor capability plus the bundle-level per-day spend cap and records the decision in `capability_uses`. It is not gated on Effect emission because LLM calls happen *during* a processor's `run()`, before any Effect is returned.

The cap-enforcement scenario at `tests/harness/scenarios/capabilities/model-invoke-scheduled.scenario.test.ts` exercises this path.

## Related

- [[wiki/specs/effects]] §"Effect × capability compatibility"
- [[wiki/specs/capabilities]]
- [[wiki/specs/processors]] §"Capabilities"
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
- [[wiki/gotchas/capability-downgrade-surprise]]
- [[wiki/matrices/effect-router-targets]] — what happens after the capability check
