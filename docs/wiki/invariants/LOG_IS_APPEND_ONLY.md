---
type: invariant
created: 2026-05-27
updated: 2026-06-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[cohesive/brainstorms/2026-06-11-dome-v1-plan]]"
enforced_by:
  - tests/invariants/no-accreting-registries.test.ts
  - tests/extensions/dome.agent/grant-aware-tools.test.ts
tier: axiom
---

# LOG_IS_APPEND_ONLY

**Tier:** Axiom — non-disable-able.

**Statement:** Entries in `<vault>/log.md` are never modified or deleted in place. As of 2026-06-11 the file is **frozen** — the strongest (degenerate) form of append-only: zero appends. Nothing writes `log.md` at all; the vault's activity record is git history (engine commit bodies carry the patch narrative per [[wiki/specs/adoption]] §"Engine commit trailers", rendered by `dome log`), and existing `log.md` content is preserved history.

**Superseded direction (2026-06-11):** the originally planned `dome.log` bundle — an adoption-phase `append-log` processor projecting the run ledger into `log.md` under an `owns.path: ["log.md"]` grant — is **retired**, not deferred. [[wiki/invariants/NO_ACCRETING_REGISTRIES]] is the superseding rule: no file's maintenance contract is "append entries forever," and the three jobs the markdown log was meant to do are covered without it:

- **Narrative activity** rides the engine commit body (the PatchEffect's sanitized `reason`; agents feed it from their final message) and replicates with every vault clone — better durability than the gitignored `runs.db` the projection would have re-narrated.
- **Queryable history** is `dome log` (`--since` / `--processor` / `--grep`), joining `Dome-*` trailers with the run ledger.
- **Non-commit events** (failed runs, denials, quarantines) stay in `runs.db` and surface through `dome check` / `dome inspect` — they never needed a markdown registry.

The accepted regression: commit messages are not FTS-indexed; activity lookup is `dome log`, not `dome query`. The accepted trade: a vault read without git tooling loses the activity narrative — outweighed by deleting the standing chore of a model re-narrating what the engine already recorded.

**Structural enforcement:** the freeze fences in `tests/invariants/no-accreting-registries.test.ts` — no charter instructs `log.md` appends; the `dome.agent` manifest, shipped-default vault-config grant, and tool-local writable-path mirrors all exclude `log.md` from `patch.auto` (read stays granted); the grant-aware tools deny a stray write at tool time (`tests/extensions/dome.agent/grant-aware-tools.test.ts`). With no granted writer, in-place mutation of existing entries is denied a fortiori.

**Counter-example:** A "log compaction" extension decides `log.md` is too large and wants to rewrite it with summarized entries. Wrong twice over: no first-party surface holds (or should request) write capability over `log.md`, and the compaction itself would rewrite history-of-record. If a vault wants the file out of the way, the owner renames it (`log-archive-through-<date>.md`) as an ordinary human commit — Dome ships no rotation machinery.

**Related:**
- [[wiki/invariants/NO_ACCRETING_REGISTRIES]] — the superseding rule
- [[wiki/specs/vault-layout]] §"`log.md` — frozen history"
- [[wiki/specs/cli]] §"`dome log`" — the activity surface
- [[wiki/specs/run-ledger]] — the structured audit source
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the provenance layer `dome log` reads
