# Run-ledger write-rate reduction: payload cap + health-trio cadence

**Date:** 2026-07-04
**Status:** design, approved direction (recommended options; Mark AFK — both knobs reversible) — ready for implementation plan
**Continues:** [[2026-07-03-run-ledger-retention]] — retention caps *growth*; this attacks the *write rate* that sets the steady-state size. Live profile (post-prune, 183k rows): `trigger_payload_json` 375 MB where **2,612 rows >16 KB carry 281 MB (75%)**; `effect_hashes_json` 502 MB spread across all rows (avg ~2.9 KB, max 1.18 MB); the `dome.health` recovery trio on `cron: * * * * *` writes the ~4.3k rows/day floor.

## Grounding (what the map established)

- **`trigger_payload_json` is cardinality, not fat payloads.** `triggerPayloadOf` (`src/processors/runtime.ts:1603`) serializes `{trigger, matchedSignals}[]`; each matched signal is just `{signal, path}`. A bulk commit fans thousands of path pairs into every broadly-subscribed processor's row. **No structural reader exists**: the only parser is the row codec's well-formedness check to opaque `unknown` (`src/ledger/runs.ts:1439`); scheduler/dedup/quarantine/orphan paths never read the column's structure. Tests pin codec validity (valid JSON round-trips), not payload shape.
- **The health trio tolerates 5-minute cadence by construction.** Orphan-run eligibility has a **hard 5-minute floor** (`DEFAULT_ORPHAN_RUN_AGE_MS`, clamped in `operational-query-view.ts:78-82`); outbox questions surface rows already terminally `failed` (the outbox's own `nextAttemptAt` backoff drives retries independently); quarantine is persistent owner-gated state. No automatic remediation runs on the cron tick — remediation is the (non-cron) answer path. The trio is the **only** minute-cadence cron in shipped bundles.
- **`effect_hashes_json` has no verifier** — produced by the executor (`effects.map(hashEffect)`), displayed only as a count (`inspect.ts:687`), never compared or verified. But its bytes are spread across all content rows, so a cap degrades per-effect audit granularity broadly rather than trimming a tail.

## Design

### 1. Cap `matchedSignals` at write time: 50 paths per trigger + a truncation marker

In `triggerPayloadOf` (the single construction site feeding both `insertQueued` call sites), truncate each entry's `matchedSignals` to the first **50** events and, when truncated, append one marker element recording the drop, e.g.:

```json
{ "signal": "dome.ledger.truncated", "path": "…+2137 more matched signals" }
```

- Same element shape as real entries → the serialized payload stays exactly the JSON the codec expects (well-formed; opaque to all readers).
- The trigger declaration itself is never truncated; the true total is preserved in the marker.
- Constant `MATCHED_SIGNALS_MAX = 50` beside `triggerPayloadOf`, mirroring the `REASON_BODY_MAX_CHARS` truncation precedent (`src/engine/core/apply-patch.ts:270`).
- Effect: worst-case rows drop ~131 KB → ~4 KB; 98.6% of rows are byte-identical; ~270 MB of the current 375 MB never gets written again.

### 2. Health trio → `*/5 * * * *`

`assets/extensions/dome.health/manifest.yaml`: the three recovery-question processors' `cron: "* * * * *"` become `cron: "*/5 * * * *"`. Worst-case question-surfacing latency grows ≤4 min on states whose eligibility floor is already ≥5 min (orphan) or already terminal (outbox, quarantine). Floor write rate drops ~4.3k → ~860 rows/day.

### 3. Explicitly NOT in this change

- **`effect_hashes_json`** — untouched. Its posture ("summarize, cap, or drop — nothing verifies it") is a standalone audit-fidelity decision; cadence + retention already curb its growth. Filed as a follow-up.
- The ledger schema, retention machinery, and doctor probe — all unchanged (this phase writes less; it deletes nothing).

## Expected steady state

30-day retention window × reduced write rate ≈ **~300–400 MB** work-vault runs.db (under the 512 MB doctor threshold), vs ~2 GB+ unbounded before this arc.

## Testing

- `triggerPayloadOf` unit: ≤50 matched signals → byte-identical payload; >50 → exactly 50 + one marker carrying the dropped count; multiple triggers truncate independently; serialized result parses as valid JSON (codec round-trip through `insertQueued` → `getRun`).
- Manifest: the three health processors' cron is `*/5 * * * *` (manifest-schema tests still green; any test pinning the old cron updated).
- No other behavior change: orphan/outbox/quarantine question tests unchanged.

## Acceptance criteria

1. No persisted `trigger_payload_json` exceeds ~4 KB for new runs; the marker records the true dropped count; the codec round-trip holds.
2. The health trio fires every 5 minutes; no shipped bundle retains minute cadence.
3. `effect_hashes_json` byte-untouched; follow-up filed.
