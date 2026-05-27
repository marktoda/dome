---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# LOG_IS_APPEND_ONLY

**Tier:** Axiom — non-disable-able.

**Statement:** `<vault>/log.md` is a projection of the run ledger. The only processor authorized to write to it is `dome.log.append-log` (the adoption-phase processor in the `dome.log` first-party bundle, granted `owns.path: ["log.md"]` in shipped-default vault config). It only appends new entries to the end of the file; entries are never modified or deleted in place.

**Why:** The log is the audit trail's human-readable surface. Operations on the vault are reconstructable from the log alone, without the run ledger SQLite file. If entries could be rewritten, the history-of-record property dissolves and trust falls.

**Structural enforcement:** Two layers:

1. **`owns.path` capability for `dome.log`.** The shipped-default `.dome/config.yaml` grants `dome.log` an `owns.path: ["log.md"]` capability (per [[wiki/specs/capabilities]] §"owns.path"). Any other processor's PatchEffect touching `log.md` is rejected by the broker with `code: "capability-deny-owns-path"`.
2. **The `dome.log.append-log` processor's `run()` body only emits append-shaped patches.** The patch's unified-diff payload always shows additions at end-of-file; the processor's idempotency contract (per [[wiki/specs/processors]] §"Idempotency") means re-running it against the same RunRecord input produces no patch (the row is already appended).

Together: no other processor can write `log.md` (capability fence); the authorized processor cannot rewrite existing content (append-only patch shape, enforced by the processor's structure and exercised by its test).

**Counter-example:** A "log compaction" extension decides `log.md` is too large and wants to rewrite it with summarized entries. The extension's bundle manifest requests `owns.path: ["log.md"]`. The bundle loader rejects this grant at startup with `bundle-load-failure: capability-handler-collision` (`log.md` already owned by `dome.log`). The right design: a separate adoption-phase processor with `patch.auto: ["log-archive/**"]` capability that writes frozen rollups to `log-archive/YYYY-MM.md`; the original `log.md` is never mutated in place.

**Test guarantee:** `tests/invariants/log-is-append-only.test.ts` — runs a representative ingest sequence through the engine, captures the post-run `log.md` byte length, runs more operations, asserts the post-op-N `log.md` byte-prefix matches the pre-op-N content unchanged. Also asserts that no Effect outside the `dome.log` bundle results in a `log.md` mutation (verified by enumerating `runs.db` rows with `output_commit` touching `log.md` and asserting `processor_id` starts with `dome.log:`).

## Why not just `git log`?

A fair question: every engine commit carries the four Dome-* trailers per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]; `git log --grep="^Dome-Run:"` returns the engine history; the run ledger SQLite carries the enriched per-run data (cost, capability uses, error). Why also maintain `log.md`?

Three jobs `log.md` does that `git log` (alone) cannot:

- **Self-describing markdown.** The vault must be usable from the markdown alone. A user reading the vault in Obsidian, grepping with `rg`, browsing on GitHub's web UI, or unpacking a `tar` archive that excluded `.git/` still sees the operation history via `log.md`. `git log` requires the git tooling chain and a `.git/` directory; outside that environment it doesn't exist. The `log.md` projection honors [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the vault is canonical without auxiliary indexes or auxiliary tooling.

- **Catches events that don't produce git commits.** Failed processor runs, denied capability uses, quarantined processors, blocked proposals — all land as RunRecord rows in `runs.db`, and `dome.log.append-log` projects them into `log.md`. They do not appear in `git log` (no commit fired). Without `log.md`, those events would have nowhere to land that survives `runs.db` deletion.

- **Catastrophic recovery surface.** If `.git/` corrupts or the user accidentally `rm -rf .git/`, the operation history survives in `log.md` (which is part of the committed vault, so it's also in `.git/` — but the human-readable surface persists as a file the user can read even mid-recovery). Similarly, if `runs.db` is wiped, the `log.md` projection survives until the next `--repair` (which would re-project from the now-empty ledger).

The cost is intentional duplication: the run ledger (the structured, queryable source) plus `log.md` (the human-readable, durable-in-markdown projection). `dome.log.append-log` keeps them aligned automatically; the user never maintains the alignment by hand. `log.md` is the *narrative* layer; the run ledger is the *structured-audit* layer; git trailers are the *durable-in-git* provenance layer. All three are useful; none is sufficient alone.

**Related:**
- [[wiki/specs/run-ledger]] — the structured audit source
- [[wiki/specs/processors]] §"First-party processors" — the `dome.log` bundle
- [[wiki/specs/capabilities]] §"owns.path"
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]]
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]
- [[wiki/matrices/projection-table-x-owner]] — the per-path/table writer map
