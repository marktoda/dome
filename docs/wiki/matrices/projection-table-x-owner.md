---
type: matrix
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Projection table × owner matrix

Per-table map of which extension is authorized to write to each table in `<vault>/.dome/state/projection.db` (and the adjacent `runs.db` and `outbox.db`). Writes scoped by the broker's `graph.write` capability per [[wiki/specs/capabilities]] §"graph.write".

## The matrix

| Database | Table | Writers (extensions) | Schema authority | Capability gate |
|---|---|---|---|---|
| `projection.db` | `facts` | `dome.intake` (namespaces: `dome.tasks`, `dome.people`); `dome.search` (namespace: `dome.search`); third-party bundles per their `graph.write` grants | [[wiki/specs/projection-store]] §"Tables — facts" | `graph.write:<namespace>` |
| `projection.db` | `fts_documents` | `dome.search` exclusively | [[wiki/specs/projection-store]] §"Tables — fts_documents" | Internal to `dome.search.index-text`; not directly grantable to other extensions |
| `projection.db` | `diagnostics` | every processor that emits `DiagnosticEffect` | [[wiki/specs/projection-store]] §"Tables — diagnostics" | (none — every processor may emit) |
| `projection.db` | `questions` | every processor that emits `QuestionEffect` (subject to having `graph.write` of any namespace) | [[wiki/specs/projection-store]] §"Tables — questions" | implicit; granted alongside any `graph.write` |
| `projection.db` | `scheduled_jobs` | engine writes on `JobEffect` emission; processors do not write directly | [[wiki/specs/projection-store]] §"Tables — scheduled_jobs" | n/a (engine-internal) |
| `projection.db` | `schedule_cursors` | engine writes when a cron-driven processor fires | [[wiki/specs/projection-store]] §"Tables — schedule_cursors" | n/a (engine-internal) |
| `projection.db` | `projection_meta` | engine writes on rebuild | [[wiki/specs/projection-store]] §"Cache key" | n/a (engine-internal) |
| `runs.db` | `runs` | engine writes per processor invocation | [[wiki/specs/run-ledger]] §"Tables — runs" | n/a (engine-internal) |
| `runs.db` | `capability_uses` | engine (broker) writes per capability-enforcement decision | [[wiki/specs/run-ledger]] §"Tables — capability_uses" | n/a (engine-internal) |
| `outbox.db` | `outbox` | engine writes on `ExternalActionEffect` emission and on dispatch outcome | [[wiki/specs/projection-store]] §"Outbox" | n/a (engine-internal); the *emission* requires `external:<capability>` per [[wiki/matrices/effect-x-capability]] |

## Reading the matrix

- **Engine-internal tables** (`scheduled_jobs`, `schedule_cursors`, `projection_meta`, `runs`, `capability_uses`, `outbox`) are written by the engine on processor-effect emission. Processors do not write to these tables directly — they emit Effects; the engine routes the writes.
- **Processor-written tables** (`facts`, `diagnostics`, `questions`, `fts_documents`) are written by the engine on behalf of a processor that emitted the corresponding Effect, scoped by the processor's declared capabilities.
- **No table is multi-writer without namespace scoping.** `facts` allows multiple extensions to write, but each is scoped to its `graph.write` namespace; two extensions cannot write rows under the same namespace. Cross-namespace contention is prevented by construction.

## Why `fts_documents` is single-writer

`dome.search.index-text` is the only authorized writer for `fts_documents`. The table maintains an FTS5 index over markdown bodies; multiple writers would race on the index updates. The single-writer constraint is enforced by:

1. `dome.search.index-text` declares an implicit capability the broker recognizes — `internal:fts_documents.write`. The broker grants it only to `dome.search`.
2. A third-party bundle that wants its own FTS index registers its own table (e.g., `community.synonyms.fts_synonyms`) rather than writing to `fts_documents`.

This is the projection-table analogue of `owns.path` — exclusive write authority for the table.

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

`tests/integration/projection-table-x-owner.test.ts` (v1.1+ candidate) parses this matrix and asserts:
- Every shipped bundle that declares a `graph.write` capability writes only to namespaces named in its row.
- Engine-internal tables are not written by any non-engine module (verified via the `engine-is-sole-applier` semantic linter).

## Related

- [[wiki/specs/projection-store]] — table schemas + cache key
- [[wiki/specs/run-ledger]] — `runs.db` schemas
- [[wiki/specs/capabilities]] §"graph.write"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/matrices/extension-bundle-shape]]
