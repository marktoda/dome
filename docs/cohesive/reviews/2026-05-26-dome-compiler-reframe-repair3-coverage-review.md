# End-of-run Coverage Review — Dome compiler reframe (repair pass 3)

**Verdict:** Covered

## Coverage table

| Finding / Ledger entry | Plan task(s) | Diff hunks (commit · file:lines) | Status |
|---|---|---|---|
| F1 (High, repair-2 coverage gap) — new invariants absent from generated AGENTS.md | Repair-3 T1 | `644b21d` · `src/shipped-defaults.ts:24-25`, `tests/agents-md.test.ts:41-58` | Covered |
| substrate-I1 (Medium, repair-2 alignment) — `auto-update-index` watcher claim at `VAULT_RECONCILES_AFTER_NATIVE_WRITE.md:21` not structurally true | Repair-3 T2 | `c5e8051` · `src/hooks/auto-update-index.ts:5-30`, `src/vault.ts:188-199`, `tests/invariants/vault-reconciles-after-native-write.test.ts:107-140` | Covered |
| All 15 original-ledger non-Deferred entries | — | unchanged across repair-3 | Covered (carried forward) |
| All 7 repair-1 findings (B1-B3, I1-I4) | — | closed in repair-1 commits | Covered (carried forward) |
| All 3 repair-2 findings (NEW-B1, NEW-I1, NEW-I2) | — | closed in repair-2 commits `b253cad`, `828ba6b`, `cd092fd` | Covered (carried forward) |

## What looked right

- F1 fix carries a regression-pinning test; same shape as the repair-2 NEW-I1 closure.
- substrate-I1 fix discriminates by event kind inside a single hook rather than adding a second handler. End-to-end watcher test pins the spec claim — a native fs.writeFile produces an index.md entry before reconcile.
