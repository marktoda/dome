---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: low
coverage: off-matrix
enforced_at: src/projections/db.ts
enforced_at_status: deferred
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Projection schema skew

**Symptom:** On `openVault`, the engine prints `dome: projection schema changed (vN → vM); rebuilding (~Xs for this vault)...` and a rebuild runs automatically. The vault opens slightly slower than usual; once rebuilt, subsequent opens are normal.

**Root cause:** The SDK was upgraded, the projection schema changed (new column, new table, modified index), but the vault's `<vault>/.dome/state/projection.db` has the old schema baked in. Reading rows under the new schema would either fail (missing columns the queries expect) or return malformed data.

**Structural mitigation:** **Automatic rebuild on schema-hash mismatch.**

The projection schema is identified by `projection_meta.schema_hash` — a sha256 of the concatenated `CREATE TABLE` / `CREATE INDEX` / `CREATE VIRTUAL TABLE` statements. On `openVault`:

1. The engine computes the current schema_hash from the SDK's `schema.sql`.
2. Compares to `projection_meta.schema_hash` in the existing `projection.db`.
3. If they match: open normally.
4. If they mismatch: wipe `projection.db`, recreate schema, run `dome rebuild` automatically. Surface a one-line message naming the version transition and the rebuild duration.

The auto-rebuild is **safe by construction** because of [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — anything in projection.db can be re-derived from the adopted commit + the loaded processors. No migration tooling needed; no manual user intervention.

The run ledger (`runs.db`) and outbox (`outbox.db`) carry their own schema_hashes and rebuild paths. The ledger's rebuild is partial — historical runs cannot be re-derived from markdown (the ledger holds data git doesn't carry, per [[wiki/specs/run-ledger]] §"Why a separate ledger"); a ledger schema-hash mismatch logs a one-line warning and proceeds with the old schema (the SDK ships *additive-only* ledger schema changes — new columns are nullable, new tables are independently created). The outbox's schema is similarly additive-only.

**Specific scenarios:**

- **New fact predicate index.** SDK v1.2 adds an index on `facts.predicate` for query performance. Existing vaults rebuild on first open after upgrade. ~10-30 seconds for typical vaults.

- **New `dome.search` embeddings table.** SDK v1.3 adds an embeddings table for semantic search. Existing vaults rebuild on upgrade; the rebuild re-runs `dome.search.index-embeddings` to populate the new table.

- **Schema rollback.** Downgrading the SDK to an older version produces the inverse — the older SDK's schema_hash doesn't match the newer DB's. Same automatic rebuild applies.

- **User edits `schema.sql` manually.** Don't do this. If the user manually edits schema.sql (e.g., to add a custom column for their own queries), the hash mismatches and the rebuild wipes their changes. The fix: don't edit shipped schema files; register a custom table via a third-party extension instead.

**Operational notes:**

- The rebuild is logged in the run ledger (`status: "succeeded"`, `processor_id: "engine.projection-rebuild"`). Reviewable via `dome inspect runs --processor engine.projection-rebuild`.
- For large vaults (50k+ pages), the rebuild may take a minute or two. `dome inspect rebuild-progress` (v1.x subject) provides a tail-of-walk view.
- The engine never asks "do you want to rebuild" — the rebuild is automatic. The user-visibility is the one-line message; the rebuild's idempotency means re-running it is safe.

**Related:**
- [[wiki/specs/projection-store]] §"Schema migrations"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/gotchas/processor-version-drift]]
