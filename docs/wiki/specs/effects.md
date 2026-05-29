---
type: spec
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Effects

This spec is normative for the eleven-kind effect taxonomy. An **Effect** is the only thing a [[wiki/specs/processors|Processor]] returns. The engine routes effects through capability enforcement, then applies them — by patching markdown, writing to the projection store, queueing external actions, recovering operational rows, or rendering a view.

The taxonomy is **closed**. New effect kinds require a spec change. Plugin/extension processors cannot extend the union; what they can do is emit any of the eleven existing kinds within their declared capabilities.

## The Effect union

```ts
type Effect =
  | PatchEffect
  | DiagnosticEffect
  | FactEffect
  | SearchDocumentEffect
  | QuestionEffect
  | JobEffect
  | ExternalActionEffect
  | OutboxRecoveryEffect
  | QuarantineRecoveryEffect
  | RunRecoveryEffect
  | ViewEffect;
```

Effects are immutable values. Once returned from a processor, they are routed by the engine but never modified. Effect validation (Zod schemas at the engine boundary) rejects malformed effects before routing.

The engine routes effects through the engine routing layer. Generic sink routes use `src/engine/apply-effect.ts`, which has an exhaustive `switch` on the union (TypeScript `never`-type exhaustiveness check). Garden PatchEffects use `src/engine/garden-patch-dispatch.ts` because their destination is sub-Proposal construction rather than an inline sink. Adding an effect kind without updating the route layer fails compilation. This is the structural fence behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

## PatchEffect

A proposed change to vault markdown. Carries a non-empty list of whole-content `FileChange` entries — each entry either overwrites (or creates) a file at a vault-relative path, or deletes one.

```ts
interface PatchEffect {
  readonly kind: "patch";
  readonly mode: "auto" | "propose";
  readonly changes: FileChange[];     // non-empty; whole-content writes/deletes
  readonly reason: string;            // one-line explanation for the run ledger
  readonly sourceRefs: SourceRef[];   // evidence: what the change list was derived from
}

type FileChange =
  | { kind: "write";  path: string; content: string }
  | { kind: "delete"; path: string };
```

**Why whole-content instead of a unified diff?** Earlier drafts of this spec described `patch` as a `UnifiedDiff` string. The implementation chose whole-content writes because (a) the engine's applier is pure git plumbing — it builds a new tree by overlaying blob OIDs onto the candidate's tree, so it never needed a diff library, and (b) the unified-diff shape introduced an entire class of "hunk failed to apply" failure modes (driven by content drift between when the processor ran and when the engine applied) that the whole-content shape simply doesn't have. Processors that need to surface a textual diff to the user (e.g., `dome lint --apply`) compute it themselves against the candidate's blob, where the side-by-side render is a presentation concern rather than an applier prerequisite.

PatchEffect `sourceRefs` are not globally non-empty because some deterministic processors create purely generated files with no specific evidence span. A processor with an effective `model.invoke` grant is stricter: every PatchEffect from that run must carry at least one SourceRef. The executor enforces that as output policy before the broker routes the effect, and the broker then checks every referenced path against effective `read`.

**Routing:**
- **Adoption phase, `mode: "auto"`:** the engine overlays the changes onto the candidate tree and writes one new commit per PatchEffect (with the four `Dome-*` trailers), then re-runs the loop. If `patch.auto` capability is not granted for any touched path, the effect is downgraded to `mode: "propose"` and emits a `capability-downgrade-surprise` diagnostic; the proposed patch then follows the blocking review path below.
- **Adoption phase, `mode: "propose"`:** the engine blocks adoption with `patch.propose.requires-review`, naming the proposed changes. The review/apply surface is planned; no shipped v1 CLI command applies the proposed patch directly yet.
- **Garden phase, `mode: "auto"`:** the engine constructs a new Proposal from the changes and routes it through the adoption loop (per [[wiki/specs/proposals]] §"Garden-emitted Proposals").
- **Garden phase, `mode: "propose"`:** v1.0 records the allowed `patch.propose` capability use, emits `garden.patch-propose-review-unavailable`, and drops the patch because the garden review queue is not wired yet. v1.x will route this to a PR/review queue rather than applying inline.
- **View phase:** rejected — view processors cannot emit patches.

**Idempotency requirement:** a processor that re-runs against the same input must produce the same change list (byte-equivalent `content` for writes, same `path` for deletes). If applying the changes a second time would produce no tree-level diff (because the contents already match), the processor returns no effect. This is what makes the fixed-point loop converge.

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
| `block` | **Blocks adoption.** The engine emits `engine.adoption.blocked`, refuses to advance the adopted ref, and surfaces the diagnostic via `dome sync` exit code 1 or the `dome serve` run ledger. The user resolves, commits the fix, and syncs again. |

In the garden phase, `block` is treated as `error` — garden processors cannot block adoption (they run *after* it). In the view phase, only `info` and `warning` are emitted.

**Persistence:** diagnostics are written to `projection_store.diagnostics` ([[wiki/specs/projection-store]] §"Tables") with `(processor_id, code, proposal_id, subject_hash)` as the dedup key. Processor-emitted diagnostics and engine-created diagnostics (capability denials, phase mismatches, adoption/scheduler/job orchestration failures) use the same table; engine-created rows use synthetic producer ids such as `engine.adoption`, `engine.scheduler`, and `engine.jobs`. `dome inspect diagnostics` reads from there.

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

**Routing:** the engine writes the fact to `projection.db.facts` under the processor's declared `graph.write` namespace (the part of `predicate` before the first dot, e.g., `dome.tasks.*` → namespace `dome.tasks`). If the namespace is not granted, the effect is rejected with a capability diagnostic. Pinned by [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].

**Mandatory sourceRefs:** facts without `sourceRefs.length > 0` are rejected at validation. The "no evidence, no durable claim" property ([[wiki/specs/proposals]] introduction) is structurally enforced here.

## SearchDocumentEffect

A full-text-search projection update for adopted markdown.

```ts
type SearchDocumentEffect =
  | {
      readonly kind: "search-document";
      readonly operation: "upsert";
      readonly path: string;
      readonly category: string;      // wiki | notes | inbox | raw | other
      readonly type?: string;         // page type/frontmatter type when present
      readonly title: string;
      readonly body: string;
      readonly sourceRefs: SourceRef[]; // mandatory evidence for query results
    }
  | {
      readonly kind: "search-document";
      readonly operation: "delete";
      readonly path: string;
      readonly sourceRefs: SourceRef[];
    };
```

**Routing:** the engine writes/deletes rows in `projection.db.fts_documents`
when the processor holds `search.write` for `path`. This is intentionally a
first-class effect/capability rather than direct SQLite access by
`dome.search`: processors stay pure, the projection store remains rebuildable,
and third-party search-like bundles can request their own path-scoped authority
without escaping the broker.

**Idempotency requirement:** upsert replaces the row for `path`; delete removes
the row. A rebuild replays SearchDocumentEffects from adopted markdown and
reconstructs the same FTS state.

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

**Routing:** written to `projection.db.questions` when the processor holds `question.ask`. The user surfaces them via `dome inspect questions` (CLI) or the query API (`dome query --questions`). When the user answers, the answer is written back to the originating page (via a garden-emitted PatchEffect from `dome.intake`) or handled by the relevant answer-handler processor, and the question row is marked resolved. Answer-handler triggers can require both an idempotency-key prefix and the `processorId` that created the question row; privileged operational handlers must use both so another question emitter cannot borrow their recovery capability by forging a prefix.

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

**Routing:** the engine enqueues the job in `projection.db.scheduled_jobs` when the processor holds `job.enqueue` for the target processor. After adoption/garden/scheduler work completes, due jobs are drained as garden-phase invocations of the named processor. The target sees `JobEffect.input` as `ctx.input`; its emitted effects route through the same garden boundary. Retryable job failures are retried up to `maxAttempts` with bounded backoff, then marked `failed`; deterministic failures are marked `failed` immediately.

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

**Routing:** the engine inserts a row in `outbox.db` with `status: "pending"` and `next_attempt_at = enqueued_at`, then attempts the external call via the capability handler registered for `capability`. On success, the row updates to `status: "sent"` with the external system's id. On failure, retries per `maxAttempts` (default 3) with bounded exponential backoff by advancing `next_attempt_at`; terminal failure marks `status: "failed"`. Pinned by [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]].

**No fire-and-forget.** The engine never attempts an external call without an outbox row preceding it. This is what makes retries idempotent (the idempotencyKey de-dups) and failures recoverable. Recovery on terminal failure follows the engine-asks model: failed rows are visible through health/inspect surfaces; `dome.health.outbox-recovery-questions` raises a `QuestionEffect`; the user answers via `dome answer <id> retry|abandon` (the universal user-decision channel per [[wiki/specs/cli]] §"dome answer"); `dome.health.outbox-recovery-answer` emits an `OutboxRecoveryEffect`; the engine-owned outbox sink applies the state transition.

## OutboxRecoveryEffect

A recovery transition for a durable outbox row.

```ts
interface OutboxRecoveryEffect {
  readonly kind: "outbox-recovery";
  readonly action: "retry" | "abandon";
  readonly idempotencyKey: string;    // existing outbox row idempotency key
  readonly reason: string;            // audit explanation
  readonly sourceRefs: SourceRef[];   // question/source that justified recovery
}
```

**Routing:** garden phase only. The effect is capability-checked via `outbox.recover` for the requested action. `action: "retry"` moves a failed outbox row back to `status: "pending"` with attempts reset and `last_error` cleared. `action: "abandon"` moves a failed row to `status: "abandoned"` so it stops surfacing as actionable while remaining auditable. Adoption processors cannot emit this effect because recovery is a post-adoption operational decision; view processors cannot emit it because views do not mutate state.

**Why an effect instead of direct outbox access:** answer handlers are processors. Letting them import `outbox.db` accessors would create a second write path outside the broker and ledger. This effect keeps operational recovery under the same Processor → Effect → capability → sink contract as every other mutation.

## QuarantineRecoveryEffect

A recovery transition for processor quarantine state.

```ts
interface QuarantineRecoveryEffect {
  readonly kind: "quarantine-recovery";
  readonly action: "reset";
  readonly phase: "adoption" | "garden" | "view";
  readonly processorId: string;
  readonly processorVersion: string;
  readonly triggerHash: string;
  readonly quarantineId: string;
  readonly quarantinedAt: string;
  readonly consecutiveRetryableFailures: number;
  readonly reason: string;
  readonly sourceRefs: SourceRef[];
}
```

**Routing:** garden phase only. The effect is capability-checked via `quarantine.recover` for `action: "reset"`. The engine-owned sink clears the matching quarantine generation `(phase, processorId, processorVersion, triggerHash, quarantineId)` from durable processor execution state only if the current row still matches `quarantinedAt` and `consecutiveRetryableFailures`. Stale answers therefore cannot clear a later re-quarantine for the same trigger. Adoption processors cannot emit this effect because quarantine recovery is a post-adoption operational decision; view processors cannot emit it because views do not mutate state.

**Why an effect instead of direct quarantine access:** quarantine state controls whether processor code is allowed to run. Resetting it must be visible in the run ledger and capability audit trail, so recovery follows the same engine-asks model as outbox recovery: health processors read operational state, ask a question, answer handlers emit a recovery effect, and the engine applies the state transition.

## RunRecoveryEffect

A recovery transition for a stuck running ledger row.

```ts
interface RunRecoveryEffect {
  readonly kind: "run-recovery";
  readonly action: "fail";
  readonly runId: string;
  readonly startedAt: string;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly phase: "adoption" | "garden" | "view";
  readonly reason: string;
  readonly sourceRefs: SourceRef[];
}
```

**Routing:** garden phase only. The effect is capability-checked via `run.recover` for `action: "fail"`. The engine-owned ledger sink transitions the matching `status: "running"` run to `status: "failed"` only when `runId`, `startedAt`, `processorId`, `processorVersion`, and `phase` still match. Stale answers therefore cannot mutate a later, already-terminal, or differently-owned run row. If the sink finds no current row, routing records a `run-recovery.stale-or-missing` warning diagnostic instead of silently reporting success. Adoption processors cannot emit this effect because run recovery is a post-adoption operational decision; view processors cannot emit it because views do not mutate state.

**Why an effect instead of direct ledger access:** the run ledger is the audit backbone. Marking an orphaned row failed must itself be capability-checked and ledgered, so recovery follows the same engine-asks model as outbox and quarantine recovery: health processors read operational state, ask a question, answer handlers emit a recovery effect, and the engine applies the state transition.

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
| SearchDocumentEffect | `search.write` for the indexed document path |
| QuestionEffect | `question.ask` for the question namespace/channel |
| JobEffect | `job.enqueue` for the target processor id |
| ExternalActionEffect | the named `capability` (e.g., `calendar.write`) |
| OutboxRecoveryEffect | `outbox.recover` for `retry` or `abandon` |
| QuarantineRecoveryEffect | `quarantine.recover` for `reset` |
| RunRecoveryEffect | `run.recover` for `fail` |
| ViewEffect | (none — view emission is the phase's purpose; the broker enforces phase compatibility instead) |

## Why a closed taxonomy

Three properties depend on the union being closed:

1. **Exhaustive routing.** The engine route layer uses TypeScript exhaustiveness to guarantee every kind has a route. Adding a kind without a route fails compilation.
2. **Capability enforcement is tractable.** A finite kind set lets the broker's capability table stay finite. Open-ended effect kinds would require open-ended capability tables, which would degrade into "trust the manifest."
3. **Substrate stability.** The eleven kinds cover the operations Dome's design needs (patch, validate, extract facts, index search documents, ask, enqueue work, touch the world, recover operational outbox/quarantine/run rows, render). A new kind is a *design move*, not a plugin's convenience.

## Related

- [[wiki/specs/processors]] — what emits effects
- [[wiki/specs/adoption]] — how effects route during the fixed-point loop
- [[wiki/specs/capabilities]] — what gates effect emission
- [[wiki/specs/projection-store]] — where FactEffect / SearchDocumentEffect / DiagnosticEffect / QuestionEffect / ExternalActionEffect land
- [[wiki/matrices/effect-router-targets]] — per-kind routing destinations
- [[wiki/matrices/effect-x-capability]] — per-kind capability requirements
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]] — the structural fence
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — the broker fence
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — the outbox fence
