# End-of-run Coverage Review — Dome compiler reframe (repair pass)

**Verdict:** Covered

## Coverage table

The repair plan declared 7 tasks mapping to 7 findings; each task landed in its own commit and the diff hunks match the plan's prescribed edits one-to-one. The whole-branch coverage (first pass + repair pass) jointly covers every non-Deferred ledger entry.

| Repair-plan task / Ledger entry | Plan task(s) | Diff hunks (commit · file:lines) | Status |
|---|---|---|---|
| B1. EVERY_WRITE_IS_LOGGED reconcile-path enforcement | T4 | `3cb8615` · `src/hooks/log-out-of-band-write.ts:1-40`, `src/vault.ts:197-222`, `tests/invariants/vault-reconciles-after-native-write.test.ts:32-59`, `tests/hooks/log-out-of-band-write.test.ts:47-77` | Covered |
| B2. strip SENSITIVE_GOES_TO_INBOX from shipped prompts | T1 | `5f8db50` · `src/prompts/builtin/ingest.md:20-22`, `system-base.md:19`, `tests/invariants/no-retired-invariant-names-in-prompts.test.ts` (new, 30 lines) | Covered |
| B3. dome doctor AGENTS.md templated-section + CLAUDE.md drift checks | T5 | `0d7d2b7` · `src/cli/commands/doctor.ts:276-325, 451-465`, `tests/cli/doctor-checks.test.ts` (+69 lines) | Covered |
| I1. buildAgentsMdTemplated enumerates from canonical INVARIANTS | T3 | `a4214b5` · `src/agents-md.ts:7-32, 59`, `tests/agents-md.test.ts` (+16 lines) | Covered |
| I2. add 2 new invariants to INVARIANTS enum | T2 | `70ca2db` · `src/types.ts:82-83` | Covered |
| I3. reframe dome serve CLI description | T6 | `7974a0c` · `src/cli/cli.ts:114, 180` | Covered |
| I4. delete dead Sensitivity type + orphan comment | T7 | `5373043` · `src/types.ts:59-60`, `src/index.ts:33`, `src/cli/commands/lint.ts:13-15` | Covered |

## What looked right

- B1 fix discriminates by event family; tags entries `out-of-band, reconcile` vs `out-of-band, modified`.
- B2 fix bundled with a recurrence-guard test (`no-retired-invariant-names-in-prompts`) so future invariant retirements can't reintroduce this drift mode.
- B3 closure includes both the detection (CHECK 10) and the repair extension (CLAUDE.md content restoration).
