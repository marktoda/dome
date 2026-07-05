# Effect-hashes cap: fingerprint the first 100, count the rest

**Date:** 2026-07-05
**Status:** design, approved (option B of the exploration) — ready for implementation plan
**Continues:** [[2026-07-04-ledger-write-rate]] — the last fat column. Live profile: `effect_hashes_json` is 497 MB, **87% (430 MB) in 2% of rows** — `dome.graph.links` (avg 824 hashes/run) and `dome.search.index-text` (avg 631), mass re-emission processors; 59% of rows are `[]`.

## Grounding (what the exploration established)

- **Intent was audit provenance, never verification.** The hashes are `sha256(JSON.stringify(effect))` — non-canonical, and every effect embeds its `sourceRef.commit` OID and full payload, so the same logical effect hashes differently every run. The fingerprints in the fat tail are effectively noise: you cannot reconstruct effects from them nor diff runs by them.
- **The only consumer is a count** (`dome inspect patches` → `effectHashes.length`). Non-commit effects keep their full content in typed sinks keyed by `runId`; commit-producing effects live in git behind the `Dome-Run` trailer.
- **The `EVERY_EFFECT_IS_LEDGERED` invariant asserts machinery that does not exist**: a `ledger.recordEffect()` per-effect writer and a per-hash join back to the sinks. Nothing implements either — the doc must be corrected regardless of the cap (owned-prose discipline).
- **No schema change is needed**: the read codecs are `z.array(z.string().min(1))`; a capped array with a sentinel string is codec-valid. The column stays `TEXT NOT NULL`; no migration, no DDL.

## Design

### 1. Cap at the single collection site

In `src/processors/executor.ts` (where `effects.map(hashEffect)` is built), cap the stored list:

- `EFFECT_HASHES_MAX = 100` (constant beside `hashEffect`).
- ≤100 effects → identical output (no sentinel).
- \>100 → the first 100 hashes plus ONE sentinel string as the final element: `…+<dropped> more effect hashes` (e.g. `…+724 more effect hashes`), where `<dropped>` is the true dropped count.
- The `effects` array on the result is untouched — only `effectHashes` is capped. Every downstream consumer (runtime pass-through, `markSucceeded`, both codecs) sees the capped list consistently; the sentinel satisfies `z.array(z.string().min(1))`.
- Mirrors the `MATCHED_SIGNALS_MAX` precedent shipped yesterday (same doc-comment framing: an audit-granularity bound, not a behavior change — nothing verifies these hashes).

### 2. Keep the count honest in `dome inspect patches`

`inspect.ts`'s `effect_hashes` column currently shows `effectHashes.length`, which would read 101 for a capped row. Teach it the sentinel: when the last element matches `^…\+(\d+) more effect hashes$`, display the true emitted total (`100 + dropped`); otherwise `length` as today. One small pure helper (e.g. `effectHashCount(hashes): number`) beside the row-building code, unit-tested.

### 3. Correct the invariant prose

`docs/wiki/invariants/EVERY_EFFECT_IS_LEDGERED.md` currently claims `src/engine/core/apply-effect.ts` calls `ledger.recordEffect()` per effect and that hashes are "joined back … the union is the complete audit history." Rewrite those passages to the truth:

- The executor computes `effects.map(hashEffect)` once per run; `markSucceeded` persists it on the run row (capped at `EFFECT_HASHES_MAX` with a `…+N more` sentinel).
- The content record for every effect lives in its typed sink (git commits via `Dome-Run`; facts/diagnostics/questions in projection.db; external actions in outbox.db), keyed by `runId` — the run row's hash list is a fingerprint-and-count index, not the content record and not a verification primitive.
- Do not weaken the invariant's statement (every emission remains traceable through the sinks + the run row); fix only the false mechanism claims. Bump `updated:` frontmatter.

Also sweep `docs/wiki/specs/run-ledger.md` if it describes the hash list as complete/uncapped (add the cap + sentinel to the effect-hashes row/prose).

## Out of scope

- Any schema/DDL change, migration, or column drop (option D — rejected).
- A real effect-audit/verification surface (would be a fresh design: canonical hashing + a verifier).
- The remaining small follow-ups (prune stats fast-path; doctor-rollup e2e seam) — unchanged.

## Expected effect

New writes: worst-case `effect_hashes_json` drops ~55 KB → ~6.8 KB/row. At 30-day steady state the column falls from ~430 MB to ~25 MB; whole-file steady state lands ~150–250 MB, comfortably under the 512 MB doctor threshold.

## Testing

- Executor unit: ≤100 → byte-identical, no sentinel; 120 → exactly 100 hashes + `…+20 more effect hashes`; boundary at exactly 100 → no sentinel (the payload-cap review taught us to pin the boundary); each real hash still 64-hex.
- Round-trip: a dispatch whose processor emits >100 effects persists the capped list and both codecs decode it (runs + capability-uses JOIN).
- Inspect: `effect_hashes` shows the true total for a capped row (e.g. 824), `length` for uncapped; helper unit-tested for the no-sentinel, sentinel, and malformed-sentinel (fall back to length) cases.
- Docs: invariant no longer mentions `recordEffect`; lockstep/invariant-coverage suites green.

## Acceptance criteria

1. No new `effect_hashes_json` exceeds 101 elements; sentinel carries the true dropped count; codecs round-trip.
2. `dome inspect patches` reports true emitted totals for capped rows.
3. `EVERY_EFFECT_IS_LEDGERED` describes the real mechanism; no doc claims per-hash joins or `recordEffect`.
