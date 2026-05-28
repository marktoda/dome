---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Effects

This spec is normative for the seven-kind effect taxonomy. An **Effect** is the only thing a [[wiki/specs/processors|Processor]] returns. The engine routes effects through capability enforcement, then applies them — by patching markdown, writing to the projection store, queueing external actions, or rendering a view.

The taxonomy is **closed**. New effect kinds require a spec change. Plugin/extension processors cannot extend the union; what they can do is emit any of the seven existing kinds within their declared capabilities.

## The Effect union

```ts
type Effect =
  | PatchEffect
  | DiagnosticEffect
  | FactEffect
  | QuestionEffect
  | JobEffect
  | ExternalActionEffect
  | ViewEffect;
```

Effects are immutable values. Once returned from a processor, they are routed by the engine but never modified. Effect validation (Zod schemas at the engine boundary) rejects malformed effects before routing.

The engine routes effects via `src/engine/apply-effect.ts` — a single chokepoint with an exhaustive `switch` on the union (TypeScript `never`-type exhaustiveness check). Adding an 8th effect kind without a route in `apply-effect.ts` fails compilation. This is the structural fence behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

## PatchEffect

A proposed change to vault markdown.

```ts
interface PatchEffect {
  readonly kind: "patch";
  readonly mode: "auto" | "propose";
  readonly patch: UnifiedDiff;        // standard unified-diff format
  readonly reason: string;            // one-line explanation for the run ledger
  readonly sourceRefs: SourceRef[];   // evidence: what the patch was derived from
}
```

**Routing:**
- **Adoption phase, `mode: "auto"`:** the engine applies the patch to the candidate tree, then re-runs the loop. If `patch.auto` capability is not granted for any touched path, the effect is downgraded to `mode: "propose"` and emits a `capability-downgrade-surprise` diagnostic.
- **Adoption phase, `mode: "propose"`:** the engine blocks adoption with a diagnostic naming the proposed patch; the user reviews via `dome lint --apply` (per [[wiki/specs/cli]] §"dome lint").
- **Garden phase:** the engine constructs a new Proposal from the patch and routes it through the adoption loop (per [[wiki/specs/proposals]] §"Garden-emitted Proposals").
- **View phase:** rejected — view processors cannot emit patches.

**Idempotency requirement:** a processor that re-runs against the same input must produce the same patch (byte-equivalent). If applying the patch a second time would produce no diff (because the patch is already in the tree), the processor returns no effect. This is what makes the fixed-point loop converge.

## DiagnosticEffect

A finding that the user (or another processor) should know about.

```ts
interface DiagnosticEffect {
  readonly kind: "diagnostic";
  readonly severity: "info" | "warning" | "error" | "block";
  readonly code: string;              // canonical machine-readable id, e.g., "wikilink.unresolved"
  readonly message: string;           // human-readable
  readonly sourceRefs: SourceRef[];   // where in the vault the diagnostic applies
}
```

**Severity behavior in the adoption phase:**

| Severity | Effect on the adoption loop |
|---|---|
| `info` | Recorded in the run ledger; not surfaced to the user unless they ask. |
| `warning` | Recorded; surfaced in `dome status` and `dome lint` output; non-blocking. |
| `error` | Recorded; surfaced; non-blocking but visible. |
| `block` | **Blocks adoption.** The engine emits `engine.adoption.blocked`, refuses to advance the adopted ref, and surfaces the diagnostic via `dome submit` exit code 1. The user resolves and re-submits. |

In the garden phase, `block` is treated as `error` — garden processors cannot block adoption (they run *after* it). In the view phase, only `info` and `warning` are emitted.

**Persistence:** diagnostics are written to `projection_store.diagnostics` ([[wiki/specs/projection-store]] §"Tables") with `(proposalId, processorId, code)` as the upsert key. `dome show diagnostics` reads from there.

## FactEffect

A structured assertion the processor extracted from the vault.

```ts
interface FactEffect {
  readonly kind: "fact";
  readonly subject: NodeRef;
  readonly predicate: string;         // namespaced; e.g., "dome.tasks.dueDate", "acme.calendar.attendee"
  readonly object: NodeRef | Literal;
  readonly assertion: "explicit" | "extracted" | "inferred" | "generated";
  readonly sourceRefs: SourceRef[];   // mandatory; no-evidence-no-claim
  readonly confidence?: number;       // 0..1; required when assertion is "inferred" or "generated"
}

type NodeRef =
  | { kind: "page";  path: string }
  | { kind: "task";  stableId: string }
  | { kind: "entity"; name: string };

type Literal =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "date";   value: string };  // ISO-8601
```

**Routing:** the engine writes the fact to `projection_store.facts` under the processor's declared `graph.write` namespace (the part of `predicate` before the first dot, e.g., `dome.tasks.*` → namespace `dome.tasks`). If the namespace is not granted, the effect is rejected with a capability diagnostic. Pinned by [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].

**Mandatory sourceRefs:** facts without `sourceRefs.length > 0` are rejected at validation. The "no evidence, no durable claim" property ([[wiki/specs/proposals]] introduction) is structurally enforced here.

## QuestionEffect

A question the processor wants to ask the user.

```ts
interface QuestionEffect {
  readonly kind: "question";
  readonly question: string;
  readonly options?: ReadonlyArray<string>;  // when present, the user picks one; when absent, free-form
  readonly sourceRefs: SourceRef[];          // what prompted the question
  readonly idempotencyKey: string;           // dedup key — same question on retry produces one row
}
```

**Routing:** written to `projection_store.questions`. The user surfaces them via `dome questions` (CLI) or the query API (`dome query --questions`). When the user answers, the answer is written back to the originating page (via a garden-emitted PatchEffect from `dome.intake`) and the question row is marked resolved.

The `idempotencyKey` is what keeps the question table from filling with duplicates when a garden processor runs repeatedly on the same input.

## JobEffect

A request to run another processor later.

```ts
interface JobEffect {
  readonly kind: "job";
  readonly processorId: string;        // which processor to invoke
  readonly input: unknown;             // passed as ProcessorContext.input
  readonly runAfter?: string;          // ISO-8601; if absent, runs as soon as the queue permits
  readonly idempotencyKey: string;     // dedup key
  readonly maxAttempts?: number;       // default 3
}
```

**Routing:** the engine enqueues the job in the runtime queue (an in-memory `p-queue` plus persistent `projection_store.scheduled_jobs` for survival across restarts). The job runs as a garden-phase invocation of the named processor; same effect-routing applies.

**Why a job vs a direct call:** a processor emits JobEffect when it wants follow-on work to happen *after* the current adoption loop completes, with its own RunRecord and capability scope. This is how `dome.intake` schedules `dome.daily.refresh-brief` without synchronously calling it.

## ExternalActionEffect

An effect that touches the outside world (calendar write, email send, webhook POST, notification).

```ts
interface ExternalActionEffect {
  readonly kind: "external";
  readonly capability: string;        // e.g., "calendar.write", "notify.push", "network.post"
  readonly idempotencyKey: string;    // dedup key across retries
  readonly payload: unknown;          // capability-specific
  readonly sourceRefs: SourceRef[];   // what triggered the external action
}
```

**Routing:** the engine inserts a row in `projection_store.outbox` with `status: "pending"`, then attempts the external call via the capability handler registered for `capability`. On success, the row updates to `status: "sent"` with the external system's id. On failure, retries per `maxAttempts` (default 3) with exponential backoff; terminal failure marks `status: "failed"`. Pinned by [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]].

**No fire-and-forget.** The engine never attempts an external call without an outbox row preceding it. This is what makes retries idempotent (the idempotencyKey de-dups) and failures recoverable. Recovery on terminal failure follows the engine-asks model: the engine emits a `QuestionEffect` on `engine.outbox.terminal-failure`; the user answers via `dome answer <id> retry|abandon` (the universal user-decision channel per [[wiki/specs/cli]] §"dome answer"); the deferred `dome.health` bundle's answer-handler processor applies the resulting mutation. v1.0 surfaces the failed rows via `dome show outbox`; the full answer-handler loop ships with `dome.health` in v1.x.

## ViewEffect

A rendered response to a query or command.

```ts
interface ViewEffect {
  readonly kind: "view";
  readonly name: string;              // e.g., "agenda-with", "lint-report", "weekly-rollup"
  readonly content: ViewContent;      // structured payload
  readonly scope: ReadonlyArray<SourceRef>;  // pages this view summarizes
}

type ViewContent =
  | { kind: "markdown";   body: string }
  | { kind: "structured"; data: unknown; schema: string }
  | { kind: "stream";     chunks: AsyncIterable<string> };  // for streaming LLM responses
```

**Routing:** the engine returns the view to the caller (CLI command, query API, protocol adapter). View effects are *not* persisted by default — they are computed on demand. The caller may cache; the engine doesn't.

## The SourceRef type

Mandatory on FactEffect, QuestionEffect, ExternalActionEffect; conventional on the others.

```ts
interface SourceRef {
  readonly commit: CommitOid;         // the adopted commit at fact-extraction time
  readonly path: string;              // vault-relative
  readonly blob?: BlobOid;            // optional — the blob OID at the commit
  readonly range?: TextRange;         // optional — line/character range
  readonly stableId?: string;         // optional — for facts about a marker-delimited region or a stable-id'd task
}

interface TextRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startChar?: number;
  readonly endChar?: number;
}
```

A SourceRef points to evidence inside an *adopted* commit. This is why `dome query` returns snippets that are durably resolvable — the commit OID is stable, the blob is reachable, the range is valid.

Stable IDs are used sparingly: tasks (Obsidian-Tasks syntax extended with a `^id` suffix), decisions (explicit `decision:` regions), entity claims (explicit `claim:` regions), generated regions (`<!-- dome:region id="..." -->`). Default identification is path + range; stable IDs are added only when path/range identity is insufficient.

## Effect × capability compatibility

The full matrix is at [[wiki/matrices/effect-x-capability]]. Summary:

| Effect kind | Required capability |
|---|---|
| PatchEffect (mode: "auto") | `patch.auto` for every path the patch touches |
| PatchEffect (mode: "propose") | `patch.propose` for every path the patch touches |
| DiagnosticEffect | (none — every processor may emit) |
| FactEffect | `graph.write` for the namespace prefix of `predicate` |
| QuestionEffect | `graph.write` for namespace `dome.questions` (the engine grants this to any processor that has any `graph.write`) |
| JobEffect | `job.enqueue` (default: granted to all processors for processors in the same bundle) |
| ExternalActionEffect | the named `capability` (e.g., `calendar.write`) |
| ViewEffect | (none — view emission is the phase's purpose; the broker enforces phase compatibility instead) |

## Why a closed taxonomy

Three properties depend on the union being closed:

1. **Exhaustive routing.** The engine's `apply-effect.ts` uses TypeScript exhaustiveness to guarantee every kind has a route. Adding a kind without a route fails compilation.
2. **Capability enforcement is tractable.** A finite kind set lets the broker's capability table stay finite. Open-ended effect kinds would require open-ended capability tables, which would degrade into "trust the manifest."
3. **Substrate stability.** The seven kinds cover the operations Dome's design needs (patch, validate, extract facts, ask, enqueue work, touch the world, render). A new kind is a *design move*, not a plugin's convenience.

## Related

- [[wiki/specs/processors]] — what emits effects
- [[wiki/specs/adoption]] — how effects route during the fixed-point loop
- [[wiki/specs/capabilities]] — what gates effect emission
- [[wiki/specs/projection-store]] — where FactEffect / DiagnosticEffect / QuestionEffect / ExternalActionEffect land
- [[wiki/matrices/effect-router-targets]] — per-kind routing destinations
- [[wiki/matrices/effect-x-capability]] — per-kind capability requirements
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]] — the structural fence
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — the broker fence
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — the outbox fence
