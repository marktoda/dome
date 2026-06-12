---
type: gotcha
description: "Projection schema version bump triggers an automatic projection.db rebuild on openVault; first open is slower, not a corruption sign."
created: 2026-05-27T00:00:00.000Z
updated: 2026-05-29T00:00:00.000Z
sources:
  - '[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]'
coverage: off-matrix
enforced_at: src/projections/db.ts
enforced_at_status: deferred
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
severity: low
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

The operational databases (`answers.db`, `outbox.db`, and `runs.db`) carry
their own schema hashes but do **not** share the projection rebuild behavior.
Those files hold human decisions, external-action state, and audit history
that cannot be re-derived from markdown. Unknown operational schema mismatches
are refused without mutating the file and surfaced by `dome doctor` as
`operational.schema-mismatch`; known additive migrations may preserve and
upgrade rows when the DB-specific opener implements them.

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
