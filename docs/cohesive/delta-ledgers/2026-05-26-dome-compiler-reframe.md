# Design Delta Ledger — Dome compiler reframe + sensitivity retirement

**Date:** 2026-05-26
**Worktree / branch:** `.claude/worktrees/design+dome-compiler-reframe` on `design/dome-compiler-reframe`
**Approved direction:** **Compiler with preserved-but-flagged MCP + sensitivity feature retired.** Dome turns a markdown vault into a self-maintaining substrate via three load-bearing surfaces — `dome serve` daemon (watcher + reconcile + hooks), the CLI for explicit ops, and per-vault `AGENTS.md` for chat-harness orientation. The SDK is portable across future native shells. The MCP surface stays in the codebase but is flagged as non-primary in `mcp-surface.md`. The sensitivity-classification feature is retired entirely.

**Brainstorm source:** `docs/cohesive/brainstorms/2026-05-26-dome-compiler-reframe.md`.

This rewrite aligns the substrate with what the system actually delivers in real use, retires a feature the author confirmed they will not use, and adds two new invariants + one new gotcha to fill the documentation gaps the reframe surfaced.

## Delta at a glance

This rewrite is **Design** (touches normative substrate broadly + retires one feature; no implementation work in this pass — implementation lands in a follow-on `cohesive:implement-cohesively` after `validate-rewrite` returns Approved).

- **Files:** 13 rewritten, 4 added (2 invariants, 1 gotcha, 1 ledger), 3 removed (sensitivity feature substrate)
- **Conceptual changes:** Dome's value-prop reframed around the *compiler* model rather than the gateway model; two-surface-pattern framing (native Dome shells vs agentic harnesses) introduced as the architectural commitment; `AGENTS.md` named as the canonical agent-orientation surface across chat-shaped harnesses; the MCP surface preserved in code but explicitly flagged as non-primary in v0.5; the sensitivity-classification feature retired entirely (workflow, invariant, test, scattered references); `inbox/review/` simplified to single-purpose lint-report destination; the "invariants are enforced two ways, by scope" principle (internal-Tool-mediated vs external-watcher-reconciled) made explicit in VISION.md and propagated through sdk-surface, harnesses, EVERY_WRITE_IS_LOGGED, and the new VAULT_RECONCILES_AFTER_NATIVE_WRITE axiom.
- **Named invariants:** `SENSITIVE_GOES_TO_INBOX` (deleted); `EVERY_WRITE_IS_LOGGED` (clarified: two enforcement paths — Tool-mediated + watcher-driven for native writes); `VAULT_RECONCILES_AFTER_NATIVE_WRITE` (added, axiom); `AGENTS_MD_IS_ORIENTATION_SURFACE` (added, shipped-default).
- **Behavior matrices:** `consumer-surface.md` annotated with the post-reframe interpretation (MCP row preserved but contextually demoted in prose); `intent-prompt-tools.md` row for sensitivity-classify deleted, other rows annotated with CLI-primary invocation; `tool-invariant-enforcement.md` SENSITIVE_GOES_TO_INBOX column removed.
- **Gotchas:** `out-of-band-vault-edits.md` upgraded from "tolerated workaround" framing to canonical-path documentation; `daemon-off-while-vault-mutating.md` added (catch-up cost grows linearly with time-since-reconcile); `dirty-git-state-at-reconcile.md` unchanged; pre-existing gotchas left alone.
- **Semantic linters:** none new.
- **Tests proposed:** `dome init` writes AGENTS.md + CLAUDE.md shim; `dome doctor --repair` regenerates AGENTS.md templated sections while preserving user-prose; out-of-band-write end-to-end (native filesystem write → watcher → hooks fire → invariants enforced eventually); `dome reconcile` catches up multiple missed-event types after daemon-off; `dome doctor --time-since-reconcile` surfaces drift age; deleted: all `SENSITIVE_GOES_TO_INBOX` enforcement tests.
- **Deferred (out of scope this pass):** (1) Implementation: `dome init` writing AGENTS.md + CLAUDE.md shim; `dome doctor --repair` regeneration logic; `dome doctor --time-since-reconcile` check; the watcher-driven `appendLog` hook for native writes; the deletion of code-side sensitivity plumbing (writeDocument's sensitivity_classified check, config schema entries, src/abstract-surface.ts + src/shipped-defaults.ts + src/types.ts mentions). These land in `cohesive:implement-cohesively` after Approved validation. (2) Native mobile / desktop / web / voice client surfaces — design accommodated; no implementation in scope.

## Files rewritten

- `docs/VISION.md`
  - **Before:** Five principles centered on the gateway claim ("Invariants live at the tool boundary, not in agent discipline"); MCP described as "the interface-agnostic surface" that "any MCP-capable agent" mounts; sensitivity-routing described as a structural commitment ("sensitive content waits for review").
  - **After:** Opens with "A compiler for your second brain." Six principles, with #2 ("The compiler is universal; surface opinion is per-surface") and #3 ("Invariants are enforced two ways, by scope") replacing the prior gateway-shaped claim. New `## Two surface patterns` section explicitly distinguishes native Dome surfaces (opinionated UX) from agentic harnesses (compiler-boundary contract). MCP described as preserved-non-primary in v0.5. Sensitivity references removed.
  - **Reason:** Aligns the value-prop with what the system delivers across multi-surface use; makes the architectural commitment to the compiler explicit.

- `docs/wiki/specs/harnesses.md`
  - **Before:** Recast around MCP-mounting as the canonical configuration path (`{ mcpServers: { dome: {...} } }`); "Mounting Dome in a harness — what the harness needs" listed MCP connection first.
  - **After:** Opens with the asymmetric framing (native shells vs agentic harnesses); new `## The compiler-boundary contract` section names the four load-bearing surfaces (`AGENTS.md`, CLI, daemon, reconcile); MCP demoted to optional fifth surface. "What an agentic harness needs" reordered: AGENTS.md + shell-execution + vault path; MCP listed as optional fourth.
  - **Reason:** Realizes the compiler-boundary contract from VISION.md §"Two surface patterns" in the harness-specific spec; matches actual real-world interaction (Claude Code uses native tools, not MCP).

- `docs/wiki/specs/mcp-surface.md`
  - **Before:** Opened with "This spec is normative for Dome's MCP server — the protocol surface..." asserting MCP as the canonical mount point; no status indicator; "Why MCP is the only protocol surface in v0.5" treating MCP as the load-bearing protocol.
  - **After:** Opens with `**Status in v0.5: non-primary surface.**` plus a paragraph naming AGENTS.md + CLI + daemon as Dome's actual interaction model; preserves the technical spec as documentation of the MCP server's contract when it IS mounted. The "Why MCP is the only protocol-server surface" section reframed: MCP is the only protocol-server surface, *alongside* SDK direct-import and CLI as the other consumer-shell paths; MCP exists for "the harness class between embedded SDK consumer and shell-capable harness." References to `SENSITIVE_GOES_TO_INBOX` and sub-workflow exposure removed.
  - **Reason:** Honest about MCP's actual role in v0.5 while preserving the spec's technical contract for the harnesses (current or future) that do mount the server.

- `docs/wiki/specs/sdk-surface.md`
  - **Before:** "Every mutation in Dome flows through a Tool. Tools are the *only* legitimate path to mutation" — gateway-shaped claim applied to all mutation regardless of source. `writeDocument` row in the invariant-enforcement table listed `SENSITIVE_GOES_TO_INBOX` as an enforced opt-in; the `sensitivity_classified` parameter was documented in the Tool signature.
  - **After:** The `## Tool` section now scopes the gateway claim explicitly: "Every mutation *within Dome's own dispatcher / hook / workflow chain* flows through a Tool." A second paragraph names the consumer-shell external path (native writes → watcher → reconcile → eventual hook reaction) and cites VISION's "two ways by scope" principle plus the new `VAULT_RECONCILES_AFTER_NATIVE_WRITE`. `writeDocument` row drops `SENSITIVE_GOES_TO_INBOX`; signature drops `sensitivity_classified`. Tiered-feature-model `Opt-in` row drops `SENSITIVE_GOES_TO_INBOX` and `sensitivity-classify`.
  - **Reason:** Scopes `HOOKS_CANNOT_BYPASS_TOOLS` correctly as Dome's internal-discipline axiom; removes the sensitivity-feature surface area.

- `docs/wiki/specs/cli.md`
  - **Before:** Opened with "The CLI is the side-door surface — for things neither a chat-shaped harness nor a markdown-shaped browser does well."
  - **After:** Opens with "The CLI is the primary explicit-operation surface across every consumer shell — the way both the user and an agentic harness invoke named structured operations against a vault." Adds `--time-since-reconcile` to the `dome doctor` flag list. Updates `--show review-queue` to reflect lint-report-only `inbox/review/`.
  - **Reason:** Names the CLI's actual role in the compiler-boundary contract; adds the drift-age surface that documentation recommends.

- `docs/wiki/specs/prompts-and-workflows.md`
  - **Before:** Shipped-workflows table included `sensitivity-classify` row. `## Workflow invocation` listed three contexts with intake-hook + user-intent + explicit-name on equal footing.
  - **After:** Sensitivity-classify row deleted from the table. `## Workflow invocation` re-prioritized: CLI as the primary path; intake hook as the passive path; MCP user-intent switching listed as optional / non-primary.
  - **Reason:** Retires the sensitivity workflow; aligns workflow-invocation framing with the compiler reframe.

- `docs/wiki/specs/hooks.md`
  - **Before:** Carried a `### \`inbox/review/\` — opt-in sensitivity destination` subsection plus a paragraph explaining the sensitivity-classify sub-workflow as a hook-adjacent concept; sync-opt-in example cited "sensitivity-classifier that gates the write destination"; Related list referenced `SENSITIVE_GOES_TO_INBOX`.
  - **After:** `inbox/review/` subsection rewritten as "lint-report destination" (single-purpose under the compiler reframe). Sensitivity-classify sub-workflow paragraph removed. Sync-opt-in example reworded to remove sensitivity-specific framing. Related list reference removed.
  - **Reason:** Sensitivity retired; `inbox/review/` now serves only as the lint-report destination.

- `docs/wiki/specs/vault-layout.md`
  - **Before:** `review/` directory commented as "opt-in destination (NOT an intake) — created when SENSITIVE_GOES_TO_INBOX is enabled; sensitivity-classify routes content here for manual review."
  - **After:** `review/` commented as "destination (NOT an intake) — holds `dome lint` reports awaiting user review."
  - **Reason:** Sensitivity retired; lint-only.

- `docs/wiki/matrices/consumer-surface.md`
  - **Before:** No contextual note on the MCP server row's post-reframe status.
  - **After:** Adds a "Note on the MCP server row" paragraph in the preamble: matrix preserved as-is because code-import topology hasn't changed; the *non-primary status* lives in the prose specs (VISION, harnesses, mcp-surface).
  - **Reason:** Matrix is about code-import structure; the demotion is rhetorical, not structural. The note avoids the contradiction a future reader would otherwise see between "MCP row is here" and "MCP is non-primary in the specs."

- `docs/wiki/matrices/intent-prompt-tools.md`
  - **Before:** Sensitivity-classify row in the intent table. Other rows generic about invocation. `## How intent → workflow happens` framed everything as conversational-harness-driven.
  - **After:** Sensitivity-classify row deleted. Other rows annotated with "Primary invocation: `dome <command>` from any shell." `## How intent → workflow happens` re-prioritized: CLI as primary; MCP-prompt-switching as optional.
  - **Reason:** Sensitivity retirement + CLI-primary alignment.

- `docs/wiki/matrices/tool-invariant-enforcement.md`
  - **Before:** `SENSITIVE_GOES_TO_INBOX` column with cell entries for `writeDocument`; legend entry describing the enforcement.
  - **After:** Column and legend entry removed.
  - **Reason:** Sensitivity invariant retired.

- `docs/wiki/concepts/brain-companion.md`
  - **Before:** "Ambient" bullet centered on "Accessible from any agent (Claude Code today, mobile / web / voice later). Never another app to open." Linked to harnesses.md. "Allergic to ungrounded confidence" bullet referenced sensitivity routing.
  - **After:** "Ambient" bullet rewritten: leads with desktop (AGENTS.md auto-load + CLI) and phone (v1+ native UX), explicitly cites VISION §"Two surface patterns"; the compiler daemon framed as continuously running. "Allergic to ungrounded confidence" bullet rewritten without sensitivity reference.
  - **Reason:** Concept-doc framing aligned with VISION.md; sensitivity reference removed.

- `docs/wiki/invariants/EVERY_WRITE_IS_LOGGED.md`
  - **Before:** Statement: "Every page mutation produces an `appendLog` call within the same Tool invocation." Single enforcement path: Tool-mediated.
  - **After:** Statement expanded to "Every page mutation to the vault produces a `log.md` entry" with two explicit enforcement paths: (1) Tool-mediated (synchronous Effect array), (2) Watcher-driven for native writes (`vault.out-of-band-edit` → reactive hook calling `appendLog` with `source: 'out-of-band'`). Test guarantee expanded to include the native-write regression test.
  - **Reason:** The invariant must hold across the consumer-shell boundary; the compiler-boundary contract requires this explicit framing.

- `docs/wiki/invariants/INBOX_IS_EPHEMERAL.md`
  - **Before:** Doctor-fallback layer's `review/` exclusion citing `SENSITIVE_GOES_TO_INBOX` as the rationale.
  - **After:** Same exclusion, but rationale updated to "destination for `dome lint` reports."
  - **Reason:** Sensitivity retirement.

- `docs/wiki/invariants/WORKFLOWS_KNOW_VAULT_CONTEXT.md`
  - **Before:** Comparison "Unlike `SENSITIVE_GOES_TO_INBOX` (a routing policy a project vault may not need) or `PAGE_CREATION_REQUIRES_RECURRENCE`..."
  - **After:** Comparison shortened to just `PAGE_CREATION_REQUIRES_RECURRENCE` (sensitivity reference removed).
  - **Reason:** Sensitivity retired.

- `docs/wiki/gotchas/agent-prompt-regression.md`
  - **Before:** Symptom listed "sensitivity classification drifts"; mitigation list cited `SENSITIVE_GOES_TO_INBOX`; mitigation outside the eval suite cited sensitivity routing through `inbox/review/`.
  - **After:** Symptom reworded to "content gets classified or summarized differently" (general). Sensitivity mitigation references removed. Replaced with `dome lint`'s propose-then-apply pattern as the example of "high-stakes flows that route through `inbox/review/` first."
  - **Reason:** Sensitivity retired; lint's apply-mode is the surviving example of the pattern.

- `docs/wiki/gotchas/out-of-band-vault-edits.md`
  - **Before:** Title and framing treated native writes as "tolerated workaround." Symptom phrased as confusion-inducing. Mitigation framing as "Structural response (not a mitigation because it's not a bug)."
  - **After:** Title still "Native vault writes" but with a `Status note (2026-05-26)` paragraph at the top declaring native writes the *canonical* write path under the compiler reframe. Scenario rephrased as expected behavior rather than confusion. Structural mechanism section explicitly names the watcher + reconcile loop + doctor as the three-layer machinery. Edge cases enumerated with bounded reasoning. Related list extended.
  - **Reason:** The watcher-catches-native-writes pattern is the canonical write path in the compiler model, not a workaround. The doc framing should reflect that.

- `docs/index.md`
  - **Before:** Listed `SENSITIVE_GOES_TO_INBOX` in invariants; standard alphabetical ordering.
  - **After:** `SENSITIVE_GOES_TO_INBOX` removed. `AGENTS_MD_IS_ORIENTATION_SURFACE` and `VAULT_RECONCILES_AFTER_NATIVE_WRITE` added. `HOOKS_CANNOT_BYPASS_TOOLS` annotation clarified ("Internal scope"). `EVERY_WRITE_IS_LOGGED` annotation expanded to mention two enforcement paths. Gotcha list adds `daemon-off-while-vault-mutating`; `out-of-band-vault-edits` description updated.
  - **Reason:** Index must reflect the rewrite's added/removed/clarified entries.

## Files added

- `docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md` — Axiom: every native write is eventually observed and produces the same downstream effects a Tool-mediated write would have. The integrity story for the external leg of the "two ways by scope" principle.
- `docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md` — Shipped-default invariant: the vault root carries `AGENTS.md` as the canonical agent-orientation surface; templated sections refreshed by `dome doctor --repair`; user-prose preserved via delimiter convention.
- `docs/wiki/gotchas/daemon-off-while-vault-mutating.md` — Catch-up cost grows linearly with time-since-reconcile when `dome serve` is off; performance not correctness; mitigations are operational (run as a service) + structural (`--time-since-reconcile` surface).
- `docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md` — this ledger.

## Files removed or deprecated

- `docs/wiki/invariants/SENSITIVE_GOES_TO_INBOX.md` — Invariant deleted; the sensitivity-classification feature is retired entirely per the brainstorm's sub-decision #7.
- `src/prompts/builtin/sensitivity-classify.md` — Sub-workflow prompt deleted; feature retired.
- `tests/invariants/sensitive-goes-to-inbox.test.ts` — Test deleted alongside the invariant.

## Conceptual changes

| Old concept | New concept | Status |
|---|---|---|
| "Dome IS the toolset; agents must route through Tools" (the gateway claim) | "Dome is a compiler over your markdown vault; consumer shells write however they want, the compiler reconciles" | Replaced — VISION.md §"What Dome is" + §"Principles" #2; the gateway claim survives only as Dome's internal-discipline axiom (HOOKS_CANNOT_BYPASS_TOOLS) |
| Single surface model — every harness mounts MCP | Two surface patterns — native Dome surfaces (opinionated UX) vs agentic harnesses (compiler-boundary contract) | Added — VISION.md §"Two surface patterns"; harnesses.md §"The compiler-boundary contract" |
| MCP as the canonical mount point | MCP as a non-primary, preserved-for-future-pressure surface | Demoted — mcp-surface.md `**Status in v0.5: non-primary surface.**`; harnesses.md treats MCP as optional fifth surface |
| `SENSITIVE_GOES_TO_INBOX` (opt-in invariant) + `sensitivity-classify` (sub-workflow) + `inbox/review/` as sensitivity destination | (none — feature retired) | Removed |
| `inbox/review/` as dual-purpose (sensitivity + lint) | `inbox/review/` as single-purpose (lint reports only) | Simplified — hooks.md §"`inbox/review/` — lint-report destination"; vault-layout.md `review/` comment |
| (implicit) "invariants enforced at the Tool boundary" | Explicit two-scope framing: internal (Tool-mediated, gateway-shaped) + external (consumer-shell, reconciled by watcher + reconcile) | Made explicit — VISION.md §"Principles" #3; sdk-surface.md `## Tool` section; new invariant VAULT_RECONCILES_AFTER_NATIVE_WRITE |
| (implicit) "Claude Code mounts MCP for orientation" | `AGENTS.md` is the canonical agent-orientation surface; auto-loaded via `CLAUDE.md` shim | Made explicit and load-bearing — new invariant AGENTS_MD_IS_ORIENTATION_SURFACE; harnesses.md §"The compiler-boundary contract" |
| "Out-of-band edits are tolerated workarounds" | "Native writes are the canonical write path for consumer shells; the watcher + reconcile loop is how the compiler keeps up" | Upgraded — out-of-band-vault-edits.md status note + framing |

## New or updated substrate

### Specs

- `docs/VISION.md` — full value-prop rewrite around the compiler framing; two-surface-pattern section added; principles list updated.
- `docs/wiki/specs/harnesses.md` — full rewrite; compiler-boundary-contract section added.
- `docs/wiki/specs/mcp-surface.md` — status preamble + scope clarifications + sensitivity references removed.
- `docs/wiki/specs/sdk-surface.md` — Tool-section scope clarified; `writeDocument` signature + invariant-enforcement column cleaned of sensitivity.
- `docs/wiki/specs/cli.md` — primary-explicit-op-surface framing + `--time-since-reconcile` flag.
- `docs/wiki/specs/prompts-and-workflows.md` — sensitivity-classify row removed; workflow-invocation re-prioritized.
- `docs/wiki/specs/hooks.md` — sensitivity-related sections rewritten to lint-only framing.
- `docs/wiki/specs/vault-layout.md` — `inbox/review/` comment updated.

### Behavior matrices

- `docs/wiki/matrices/consumer-surface.md` — preamble note added; MCP row preserved.
- `docs/wiki/matrices/intent-prompt-tools.md` — sensitivity row removed; CLI-primary annotations added.
- `docs/wiki/matrices/tool-invariant-enforcement.md` — `SENSITIVE_GOES_TO_INBOX` column removed.

### Named invariants

- `SENSITIVE_GOES_TO_INBOX` — removed (feature retired).
- `EVERY_WRITE_IS_LOGGED` — clarified (two enforcement paths: Tool-mediated + watcher-driven).
- `VAULT_RECONCILES_AFTER_NATIVE_WRITE` — added (axiom).
- `AGENTS_MD_IS_ORIENTATION_SURFACE` — added (shipped-default).

### Gotchas

- `daemon-off-while-vault-mutating.md` — added (catch-up cost grows with time-since-reconcile).
- `out-of-band-vault-edits.md` — upgraded from "workaround" to "canonical-path" framing.

### Semantic linter specs

none new.

### Tests / checks proposed (not yet implemented)

- `dome init` writes `AGENTS.md` + `CLAUDE.md` shim with the expected templated sections + an empty user-prose delimiter pair (regression test for new `AGENTS_MD_IS_ORIENTATION_SURFACE`).
- `dome doctor --repair` regenerates `AGENTS.md` templated sections while preserving user-prose byte-for-byte.
- `dome doctor` (without `--repair`) reports a violation when `AGENTS.md` is missing or its templated sections are out of sync with `.dome/config.yaml`.
- Out-of-band-write end-to-end: native `fs.writeFile` to `wiki/foo.md` → watcher fires `vault.out-of-band-edit` → `auto-update-index` updates `index.md`; an `appendLog` hook records the change with `source: 'out-of-band'` (regression test for the new external-path enforcement of `EVERY_WRITE_IS_LOGGED` + `VAULT_RECONCILES_AFTER_NATIVE_WRITE`).
- `dome reconcile` catching multiple missed-event types after the daemon was off — inbox-bucket files queued, git-tracked changes since the last reconciled SHA, scheduled hooks past their interval.
- `dome doctor --time-since-reconcile` reads `.dome/state/last-reconciled-sha.txt` mtime and reports the drift age in seconds / minutes / hours / days as appropriate.

## What this rewrite *did not* do

- Implementation code: not changed. The watcher-driven `appendLog` hook for native writes, the `AGENTS.md` generation in `dome init`, the `--repair` and `--time-since-reconcile` flags in `dome doctor`, and the code-side sensitivity plumbing removal (in `src/abstract-surface.ts`, `src/shipped-defaults.ts`, `src/types.ts`, the `writeDocument` `sensitivity_classified` parameter) all land in the follow-on `cohesive:implement-cohesively` after `validate-rewrite` returns Approved.
- Tests: specifications proposed above; no test files added (and the deleted sensitivity test is the only test removed from this pass).
- CI: not changed.
- The native mobile / desktop / web / voice client surfaces: design accommodated in harnesses.md §"Future-harness pressure"; no implementation in scope.
- The `karpathy-llm-wiki-gist.md` source page's incidental mention of sensitivity: left alone (it's a third-party source summary; mentioning sensitivity classification is part of describing the original gist, not Dome's commitment).
- The `src/` code references to `SENSITIVE_GOES_TO_INBOX` (in `src/abstract-surface.ts`, `src/shipped-defaults.ts`, `src/types.ts`): left alone — code-side plumbing removal is implementation-side work for the next phase.

## Remaining ambiguity

- **AGENTS.md content template not yet defined.** The new `AGENTS_MD_IS_ORIENTATION_SURFACE` invariant names the templated-vs-user-prose split and the `--repair` behavior, but doesn't enumerate exactly what content goes into the templated sections (which invariants to list? what level of detail on page types? whether to include workflow descriptions or just names?). This is a small further spec decision to make during implementation; the invariant's substrate scaffolding is sufficient for `validate-rewrite` to judge architectural soundness.
- **MCP transport-future-pressure mention.** `mcp-surface.md` §"Why MCP is the only protocol-server surface" now names HTTP REST / SSE as deferred. The relationship between a future `@dome/sdk/http` and the current MCP transports is named non-normatively; if both ship in v1+, a tighter scoping spec may be needed. Substrate-noted, not deferred-explicitly.
- **`dome serve` running the MCP server by default vs. by flag.** Current implementation: `dome serve` always launches the MCP server. The spec rewrite treats MCP as non-primary but doesn't decide whether `dome serve --no-mcp` (or `--mcp` opt-in) should exist. The brainstorm's "keep MCP around but flag it as not used" was rhetorical, not code-level. Substrate-noted; the implementer can decide whether to add a flag or leave the MCP server running when nothing consumes it.

## Repair pass 0 (initial forward rewrite)

This is the initial forward pass. No repair-pass commits yet.

## Ready for fresh-eyes review?

**Yes.** All affected docs are in end-state language; no "we will" / "should consider" in normative sections. Obsolete concepts (`SENSITIVE_GOES_TO_INBOX`, sensitivity-classify, gateway-as-universal-claim) are removed, not annotated. The delta ledger preamble accurately summarizes the body sections. Substrate inventories (index, matrices, related-lists) updated to reflect the additions and deletions.

## How to read this ledger

1. Read "Approved direction" — Dome reframes around the compiler model; sensitivity retires; MCP preserved but flagged non-primary.
2. Skim "Delta at a glance" — broad design rewrite (13 files rewritten, 4 added, 3 removed); the compiler model now load-bearing; `AGENTS.md` and `VAULT_RECONCILES_AFTER_NATIVE_WRITE` codify what the compiler boundary contract guarantees.
3. Skim "Conceptual changes" — seven concept shifts, with the gateway-claim retirement and two-surface-pattern introduction as the most load-bearing.
4. Use "Files rewritten" with before/after deltas to verify the rewrites individually.
5. Use "Remaining ambiguity" as the focused review punch list — three small open questions the implementation phase will close.
