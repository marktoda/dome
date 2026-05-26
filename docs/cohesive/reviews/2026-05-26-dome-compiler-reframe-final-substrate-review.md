# Spec Cohesion Review — Dome compiler reframe implementation

**Reviewer:** substrate-alignment-reviewer (fresh-eyes context)
**Date:** 2026-05-26
**Scope:** diff-scope review of `git diff main..HEAD` on branch `design/dome-compiler-reframe` against locked specs.

**Verdict:** Issues Found

## Executive judgment

The implementation lands four of the five major spec deltas cleanly: sensitivity is removed from types/Tools/abstract-surface, `inbox/review/` is scaffolded as a shipped-default directory, `--time-since-reconcile` works as specified, and `AGENTS.md` + `CLAUDE.md` shim generation + watcher-driven out-of-band logging are wired with regression tests. The reframe's structural shape made it to code. But three load-bearing claims of the locked specs are not yet structurally true in the implementation: (1) the `EVERY_WRITE_IS_LOGGED` external-path reconcile leg has no enforcement — only the watcher path logs; (2) `AGENTS_MD_IS_ORIENTATION_SURFACE`'s "templated sections out of sync → violation" and "CLAUDE.md pointing at the wrong file → violation" drift checks are absent from `dome doctor`; (3) `src/prompts/builtin/ingest.md` still instructs the agent to apply the retired `SENSITIVE_GOES_TO_INBOX` invariant — sensitivity will keep showing up at runtime via this prompt despite all the substrate around it being deleted.

## Blocking issues

### B1. EVERY_WRITE_IS_LOGGED's reconcile path is not structurally enforced

- **Severity:** Blocker
- **Category:** Invariant enforcement
- **Why it matters:** `docs/wiki/invariants/EVERY_WRITE_IS_LOGGED.md:17` ("`dome reconcile` does the same for events the daemon missed while it was off") and `VAULT_RECONCILES_AFTER_NATIVE_WRITE.md:22` ("events the watcher missed... get fired during reconcile and processed by the same hook chain") both promise the reconcile path produces a log entry for every native write. Implementation does not. `src/reconcile.ts:64,91,103` fires `{ kind: "wrote-document" }` Effects, which `src/event-projection.ts:58-59` projects to `document.written.<category>.<type>` events. The new `log-out-of-band-write` hook at `src/hooks/log-out-of-band-write.ts:14` only fires on `vault.out-of-band-edit` — no hook in `src/vault.ts:171-210` listens on `document.written.*` to call `appendLog`. The user runs the daemon for a week, edits 30 wiki files in vim, runs `dome reconcile`: `index.md` updates (auto-update-index fires) but `log.md` records nothing about those 30 edits. The audit trail the gotcha at `daemon-off-while-vault-mutating.md:21` promises ("`appendLog`") is silently broken.
- **Evidence:**
  - `src/vault.ts:199-210` — the only handler that calls `appendLog` for native writes is gated on `pattern: "vault.out-of-band-edit"`.
  - `src/reconcile.ts:64,91,103` — every reconcile-fired event is a `wrote-document` Effect; the projection produces `document.written.*`, never `vault.out-of-band-edit`.
  - `tests/invariants/vault-reconciles-after-native-write.test.ts` — only the watcher path is tested. The ledger §"Tests proposed" (line 28) explicitly named the reconcile-path test ("A second test sets aside the daemon, makes a similar write, runs `dome reconcile`, asserts equivalent end-state") — it's missing.
- **Recommended fix:** Either (a) register `logOutOfBandWrite` against a second pattern (e.g., wrap it so it fires for both `vault.out-of-band-edit` and a normalized form of `document.written.*` that carries the same path), or (b) have `reconcile.ts` emit `vault.out-of-band-edit` events instead of (or in addition to) `wrote-document` Effects in phases 1+2, so the same hook chain processes them. Add the missing reconcile-path test.

### B2. `ingest` workflow prompt still instructs the agent to apply the retired `SENSITIVE_GOES_TO_INBOX` invariant

- **Severity:** Blocker
- **Category:** Spec drift
- **Why it matters:** The delta ledger §"Files removed or deprecated" lists `src/prompts/builtin/sensitivity-classify.md` as deleted and the `Sensitivity` removal from `INVARIANTS` is confirmed. But `src/prompts/builtin/ingest.md:21` still tells the agent: `"If SENSITIVE_GOES_TO_INBOX is enabled, classify content first (sensitive content routes to inbox/review/)."` This prompt is loaded at runtime by the `ingest` workflow — a shipped-default workflow. The reframe's central "feature retired entirely" claim is structurally untrue at runtime.
- **Evidence:**
  - `src/prompts/builtin/ingest.md:21`
  - `src/types.ts:67-82` — `SENSITIVE_GOES_TO_INBOX` not in `INVARIANTS`
  - `docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md:126`
- **Recommended fix:** Remove step 6 from `src/prompts/builtin/ingest.md`; renumber the remaining steps. Add a test that scans `src/prompts/builtin/*.md` for the literal `SENSITIVE_GOES_TO_INBOX` and fails on match — a semantic-linter-shaped guard.

### B3. `dome doctor` does not detect AGENTS.md templated-section drift

- **Severity:** High
- **Category:** Invariant enforcement
- **Why it matters:** `docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md:25` declares: `"templated sections out of sync with current config → violation; CLAUDE.md shim missing or pointing at the wrong file → violation."` Implementation at `src/cli/commands/doctor.ts:278-297` only verifies existence + delimiters; the drift comparison and `CLAUDE.md` content check are absent.
- **Recommended fix:** In CHECK 10, parse the templated section, re-render the expected templated section from current `vault.config` / `vault.pageTypes` / `WORKFLOW_NAMES`, and emit a violation when they differ. Add CLAUDE.md content check (`body.trim() === "See AGENTS.md."`). Add a regression test.

## Important issues

### I1. The "enabled invariants" list in AGENTS.md is misleading

- **Severity:** Medium
- **Why it matters:** `src/agents-md.ts:22-25` filters `config.invariants` to `enabled` entries — that's only the 5 in `SHIPPED_VAULT_CONFIG`. Meanwhile `src/types.ts:67-82` enumerates 14 invariants the system actually depends on (axioms included). An agent reading `AGENTS.md` is told the vault enforces 5 invariants when it actually enforces ~14.
- **Recommended fix:** Either (a) render the full axiom + shipped-default invariant set from `INVARIANTS` + tier metadata, or (b) extend `SHIPPED_VAULT_CONFIG.invariants` to enumerate every invariant with its actual status.

### I2. New invariants `AGENTS_MD_IS_ORIENTATION_SURFACE` and `VAULT_RECONCILES_AFTER_NATIVE_WRITE` not added to the `INVARIANTS` enum

- **Severity:** Medium
- **Recommended fix:** Add both names to the `INVARIANTS` constant.

### I3. `dome serve` description in CLI help still leads with "MCP server"

- **Severity:** Medium
- **Evidence:**
  - `src/cli/cli.ts:180` — `.description("Start the MCP server + filesystem watcher.")`
  - `src/cli/cli.ts:114` — `"dome serve --vault ~/vaults/work    # start MCP server + watcher"`
- **Recommended fix:** Update both strings to "Start the compiler daemon (watcher + reconcile; optional MCP server)."

### I4. Two dead-end sensitivity residues in code

- **Severity:** Low
- **Evidence:**
  - `src/types.ts:61` — `export type Sensitivity = "normal" | "sensitive";` (no remaining importers)
  - `src/cli/commands/lint.ts:15` — orphan comment "when sensitivity routing is"
- **Recommended fix:** Delete the `Sensitivity` type and the orphan comment.

## Recommended repairs (ranked)

1. Land the reconcile-path enforcement of `EVERY_WRITE_IS_LOGGED` (B1) + its test.
2. Strip `SENSITIVE_GOES_TO_INBOX` from `src/prompts/builtin/ingest.md` + `system-base.md` (B2 + F1) + add a grep-shaped semantic linter against retired-invariant names in shipped prompts.
3. Add templated-section drift detection + `CLAUDE.md` content check to doctor (B3) + the matching regression test.
4. Switch `buildAgentsMdTemplated` to enumerate from `INVARIANTS` and tier metadata (I1); add the two new invariants to the enum (I2).
5. Update `dome serve` CLI strings (I3); delete the two sensitivity residues (I4).

## Next

**Disposition:** Repair → re-validate
