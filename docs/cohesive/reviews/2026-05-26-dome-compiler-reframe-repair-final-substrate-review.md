# Substrate Alignment Review — dome-compiler-reframe repair pass

**Reviewer:** substrate-alignment-reviewer (fresh-eyes, diff scope)
**Date:** 2026-05-26
**Subject:** repair pass commits `5f8db50`..`5373043` against locked specs in `docs/wiki/`

**Verdict:** Issues Found

## Executive judgment

Five of the seven prior findings (B2, B3, I2, I3, I4) close cleanly with real structural enforcement. Two close in form but not in substance: the B1 reconcile-path enforcement creates a new runtime defect — every Tool-mediated wiki write now produces 2-3 duplicate log entries falsely tagged "out-of-band" — and the I1 agents-md enumerator contradicts the locked spec on what the invariant list should contain.

## Blocking issues

### NEW-B1. `log-out-of-band-write` fires on Tool-mediated writes, producing duplicate log entries

- **Severity:** Blocker
- **Category:** Invariant enforcement (creates a runtime defect in `EVERY_WRITE_IS_LOGGED` / `LOG_IS_APPEND_ONLY`)
- **Why it matters:** The hook handler is registered against `document.written.wiki.*` at `src/vault.ts:213-219` to fulfill the reconcile-path enforcement claim. But `wrapMutatingInvoke` (`src/tools/registry.ts`) routes every Tool-mediated mutation through `projectEffectsToEvents`, which emits exactly the same `document.written.wiki.<type>` event kind (`src/event-projection.ts:23-26`). `HookEvent` has no `source` discriminator, so a `vault.tools.writeDocument` call now produces (a) the Tool's legitimate `appended-log` effect via `logMutation`, **plus** (b) a spurious `appendLog` call from `logOutOfBandWrite` tagged "out-of-band, reconcile". Under `dome serve`, the chokidar watcher fires a third time as `vault.out-of-band-edit` tagged "out-of-band, modified". The audit trail the invariant promises now claims every Tool write was simultaneously a Tool write and an out-of-band write — defeats the provenance honesty the invariant doc calls out.
- **Evidence:**
  - Subscription: `src/vault.ts:212-220` registers `logOutOfBandWrite` against `document.written.wiki.*` with no provenance filter.
  - Event projection: `src/event-projection.ts:19-26` emits identical event kinds for Tool-mediated and reconcile-replayed writes.
  - Handler: `src/hooks/log-out-of-band-write.ts:28-32` accepts any `document.written.*` event.
  - Tool-side log: `src/tools/write-document.ts:138-142` already appends its own canonical log entry.
  - Test gap: `tests/invariants/vault-reconciles-after-native-write.test.ts:54-56` asserts `toContain("out-of-band")` but never bounds the count, so the regression passes silently.
- **Recommended fix:** Add an event-source discriminator. Two viable shapes:
  - (i) Extend `HookEvent` with `source: "tool" | "reconcile" | "watcher"` plumbed from `dispatchEvents` callers. The handler short-circuits when `source === "tool"`.
  - (ii) Drop the reconcile-pattern subscription and have `reconcile.ts` phase-2 invoke `vault.tools.appendLog` directly per file — the cleaner shape; reconcile is the only place that should produce "out-of-band, reconcile" entries.
- **Substrate artifact to add or update:** Test guarantee — assert exactly one log entry per Tool write and exactly one per out-of-band write. New gotcha: "event-source ambiguity in dispatchEvents."

## Important issues

### NEW-I1. agents-md enumerates the full canonical invariant set; specs say "enabled" set

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** `cli.md:30` describes `dome init`'s `AGENTS.md` content as "the *enabled* invariant set"; `AGENTS_MD_IS_ORIENTATION_SURFACE.md` §"Statement" and §"Counter-example" both say the templated section reflects "the enabled invariant set" and gives a worked example of a flipped-on config flag changing what the file says. The repair-pass implementation at `src/agents-md.ts:23-29` does the opposite: enumerates `Object.values(INVARIANTS)` unconditionally. A vault that disables `PAGE_CREATION_REQUIRES_RECURRENCE` in config still gets a generated AGENTS.md that names it — the very drift the invariant's counter-example warns against. Compounding: `src/abstract-surface.ts:199-202` still uses the config-enabled slice for MCP `instructions`. Spec `cli.md:30` claims "MCP `instructions` mirrors it" — but the two surfaces now produce different lists in opposite ways.
- **Recommended fix:** Pick one:
  - (a) Revert `agents-md.ts:23-29` to enumerate `vault.config.invariants` filtered to `"enabled"` (matches both specs as written), and update `INVARIANTS` and `config.invariants` to include the axioms enabled-by-default. The original substrate-review I1 complaint stays addressed because axioms now appear in config too.
  - (b) If the design intent really did shift to "show the full enforcement surface," rewrite `cli.md:30` and `AGENTS_MD_IS_ORIENTATION_SURFACE.md` §"Statement"/"Counter-example" to match — and re-validate.
- **Substrate artifact:** Either the spec or the implementation. A test that pins which one is canonical.

### NEW-I2. Reconcile-path test asserts presence but not absence

- **Severity:** Medium
- **Category:** Test guarantee
- **Why it matters:** `tests/invariants/vault-reconciles-after-native-write.test.ts:32-60` writes one file, runs reconcile, asserts `log.md` contains "out-of-band". It does not bound the count, so the NEW-B1 defect passes the test cleanly.
- **Recommended fix:** Parse log.md entries and assert exactly one per write across the test fixture.

## What looked right

- B2 closure (`5f8db50`) — model shape: deleted code + grep-shaped regression test.
- B3 closure (`0d7d2b7`) — character-strict templated comparison + parallel CLAUDE.md content check + `--repair` extension.
- I2 closure — both new invariant names land with full enumeration coverage.
- I3 closure — `dome serve` reframe matches `cli.md:56` and `harnesses.md:20-23` exactly.
- I4 closure — complete deletion; `grep -n "Sensitivity"` returns empty across `src/`.

## Recommended repairs (ranked)

1. **NEW-B1:** discriminate event source so `logOutOfBandWrite` doesn't fire on Tool-mediated writes. Option (ii) — drop the wildcard subscription and call `appendLog` from `reconcile.ts` directly — is structurally simpler than threading a `source` field.
2. **NEW-I1:** reconcile `agents-md.ts:23-29` with `cli.md:30` and `AGENTS_MD_IS_ORIENTATION_SURFACE.md`. The two specs and the abstract-surface MCP path agree on "enabled"; the agents-md code is the outlier.
3. **NEW-I2:** tighten the count assertions so B1-shaped regressions can't pass silently again.

## Next

**Disposition:** Repair → re-validate

**Files to edit:**
- `src/vault.ts:212-220` — remove the `document.written.wiki.*` subscription
- `src/reconcile.ts:91-103` — call `vault.tools.appendLog({ verb: "update", subject: "${path} (out-of-band, reconcile)" })` per replayed file
- `src/agents-md.ts:23-29` — restore config-filtered enumeration
- `tests/invariants/vault-reconciles-after-native-write.test.ts:54-56` — assert exactly one log entry per write
