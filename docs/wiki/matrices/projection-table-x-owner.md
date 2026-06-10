---
type: matrix
created: 2026-05-27
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
---

# Projection table × owner matrix

Per-table map of which extension is authorized to write to each table in `<vault>/.dome/state/projection.db` (and the adjacent `runs.db` and `outbox.db`). Writes are scoped by effect-specific capabilities (`graph.write`, `question.ask`, `job.enqueue`, `external`, etc.) per [[wiki/specs/capabilities]].

## The matrix

| Database | Table | Writers (extensions) | Schema authority | Capability gate |
|---|---|---|---|---|
| `projection.db` | `facts` | processors with `graph.write` grants; shipped writers are `dome.graph.*`, `dome.daily.task-index`, `dome.daily.attention-discount` (`dome.attention.*` discount namespace), and `dome.markdown.page-status` (`dome.page.*` supersession namespace) | [[wiki/specs/projection-store]] §"Tables — facts" | `graph.write:<namespace>` |
| `projection.db` | `fts_documents` | processors that emit `SearchDocumentEffect` for granted paths; shipped writer is `dome.search.index-text` | [[wiki/specs/projection-store]] §"Tables — fts_documents" | `search.write:<path-glob>` |
| `projection.db` | `diagnostics` | every processor that emits `DiagnosticEffect` | [[wiki/specs/projection-store]] §"Tables — diagnostics" | (none — every processor may emit) |
| `projection.db` | `questions` | every processor that emits `QuestionEffect` subject to `question.ask` | [[wiki/specs/projection-store]] §"Tables — questions" | `question.ask` |
| `projection.db` | `scheduled_jobs` | engine writes on authorized `JobEffect` emission; processors do not write directly | [[wiki/specs/projection-store]] §"Tables — scheduled_jobs" | `job.enqueue:<processor-id-or-glob>` |
| `projection.db` | `schedule_cursors` | engine writes when a cron-driven processor fires | [[wiki/specs/projection-store]] §"Tables — schedule_cursors" | n/a (engine-internal) |
| `projection.db` | `projection_meta` | engine writes on rebuild | [[wiki/specs/projection-store]] §"Cache key" | n/a (engine-internal) |
| `answers.db` | `answers_meta` | engine writes schema metadata for durable question answers | [[wiki/specs/projection-store]] §"Answers DB" | n/a (engine-internal) |
| `answers.db` | `question_answers` | engine writes when a user answers a `QuestionEffect`; answer handlers update handler status | [[wiki/specs/projection-store]] §"Answers DB" | n/a (engine-internal) |
| `runs.db` | `runs` | engine writes per processor invocation | [[wiki/specs/run-ledger]] §"Tables — runs" | n/a (engine-internal) |
| `runs.db` | `capability_uses` | engine (broker) writes per capability-enforcement decision | [[wiki/specs/run-ledger]] §"Tables — capability_uses" | n/a (engine-internal) |
| `outbox.db` | `outbox` | engine writes on `ExternalActionEffect` emission and on dispatch outcome | [[wiki/specs/projection-store]] §"Outbox" | n/a (engine-internal); the *emission* requires `external:<capability>` per [[wiki/matrices/effect-x-capability]] |

## Reading the matrix

- **Engine-internal tables** (`scheduled_jobs`, `schedule_cursors`, `projection_meta`, `answers_meta`, `question_answers`, `runs`, `capability_uses`, `outbox`) are written by the engine on authorized processor-effect emission or user answer handling. Processors do not write to these tables directly — they emit Effects; the engine routes the writes.
- **Processor-written tables** (`facts`, `diagnostics`, `questions`, `fts_documents`) are written by the engine on behalf of a processor that emitted the corresponding Effect, scoped by the processor's declared capabilities.
- **No table is multi-writer without namespace scoping.** `facts` allows multiple extensions to write, but each is scoped to its `graph.write` namespace; two extensions cannot write rows under the same namespace. Cross-namespace contention is prevented by construction.

## Why `fts_documents` uses `SearchDocumentEffect`

`fts_documents` is a shared projection table, but processors still never write
SQLite directly. `dome.search.index-text` emits `SearchDocumentEffect` values;
the engine checks `search.write` for the document path and the projection sink
owns the FTS5 upsert/delete SQL. This gives Dome a narrow extension boundary:
future bundles can request path-scoped indexing authority without receiving a
generic projection-row writer.

The v1 shipped writer remains `dome.search.index-text`, granted over
`**/*.md`. A third-party bundle that wants a separate specialized index should
ship its own effect/table pair in a future substrate extension rather than
overloading `fts_documents` with unrelated semantics.

## Cross-namespace facts read

Reads from `facts` are unscoped — any processor with `read` capability on the vault can query any fact in any namespace. The namespace partitioning is a write-side trust mechanism, not a read-side privacy mechanism. (Privacy of facts across namespaces is a v2+ concern, when third-party bundles handling sensitive data ship.)

## Read access via the query API

Processors don't read from these tables via SQL — they consume the query API in `ProcessorContext.projection`:

```ts
const facts = await ctx.projection.factsBySubject({ kind: "entity", name: "Danny" });
const diagnostics = await ctx.projection.diagnostics({ severity: "block" });
const matches = await ctx.projection.searchDocuments({ query: "platform ownership" });
```

This is the protocol-adapter pattern at the projection boundary: SQLite is implementation; the query API is the contract.

## Lockstep status

Planned: `tests/integration/projection-table-x-owner.test.ts` should parse this matrix and assert:
- Every shipped bundle that declares a `graph.write` capability writes only to namespaces named in its row.
- Engine-internal tables are not written by any non-engine module (verified via the `engine-is-sole-applier` semantic linter).

## Related

- [[wiki/specs/projection-store]] — table schemas + cache key
- [[wiki/specs/run-ledger]] — `runs.db` schemas
- [[wiki/specs/capabilities]] §"graph.write"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/matrices/extension-bundle-shape]]
