# Rewrite Validation Review — Dome compiler reframe + sensitivity retirement

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-26
**Pass:** 1
**Subject:** 18 rewritten / 3 added specs against the design delta ledger at `docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md`

**Verdict:** Issues Found

## Executive judgment

The compiler reframe is conceptually clean and the two-surface-pattern framing is well-executed across VISION, harnesses, and the new `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axiom. But the sensitivity-retirement pass left live references in three normative specs, the `AGENTS.md` contract internally contradicts the non-primary MCP stance, and the CLI command count drifts three ways across the rewrite. A future contributor reading these specs cold would learn an inconsistent system: would `dome init` say sensitivity routing exists or not? Are there 7 or 8 CLI commands? Should `AGENTS.md` teach MCP mounting if MCP is non-primary? Each is a deterministic conflict, not interpretation.

## Delta at a glance

This rewrite is **Design** (touches normative substrate broadly + retires one feature; no implementation work in this pass — implementation lands in a follow-on `cohesive:implement-cohesively` after `validate-rewrite` returns Approved).

- **Files:** 13 rewritten, 4 added (2 invariants, 1 gotcha, 1 ledger), 3 removed (sensitivity feature substrate)
- **Conceptual changes:** Dome's value-prop reframed around the *compiler* model rather than the gateway model; two-surface-pattern framing (native Dome shells vs agentic harnesses) introduced as the architectural commitment; `AGENTS.md` named as the canonical agent-orientation surface across chat-shaped harnesses; the MCP surface preserved in code but explicitly flagged as non-primary in v0.5; the sensitivity-classification feature retired entirely (workflow, invariant, test, scattered references); `inbox/review/` simplified to single-purpose lint-report destination; the "invariants are enforced two ways, by scope" principle (internal-Tool-mediated vs external-watcher-reconciled) made explicit in VISION.md and propagated through sdk-surface, harnesses, EVERY_WRITE_IS_LOGGED, and the new VAULT_RECONCILES_AFTER_NATIVE_WRITE axiom.
- **Named invariants:** `SENSITIVE_GOES_TO_INBOX` (deleted); `EVERY_WRITE_IS_LOGGED` (clarified: two enforcement paths — Tool-mediated + watcher-driven for native writes); `VAULT_RECONCILES_AFTER_NATIVE_WRITE` (added, axiom); `AGENTS_MD_IS_ORIENTATION_SURFACE` (added, shipped-default).
- **Behavior matrices:** `consumer-surface.md` annotated with the post-reframe interpretation; `intent-prompt-tools.md` sensitivity-classify row deleted; `tool-invariant-enforcement.md` SENSITIVE_GOES_TO_INBOX column removed.
- **Gotchas:** `out-of-band-vault-edits.md` upgraded; `daemon-off-while-vault-mutating.md` added.
- **Semantic linters:** none new.
- **Tests proposed:** AGENTS.md generation; --repair; out-of-band-write end-to-end; reconcile catch-up; --time-since-reconcile.
- **Deferred:** Implementation work to follow-on `implement-cohesively`; native mobile/desktop/web/voice client surfaces.

## Blocking issues

### B1. Sensitivity references survive the retirement sweep

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** The retirement was a load-bearing scope choice; surviving references contradict the deletion and will confuse the next implementer reading these specs cold ("did sensitivity actually retire?"). Each reference is a place where a contributor would propagate the wrong assumption.
- **Evidence:**
  - `docs/wiki/specs/cli.md:36` — "Activating opt-in features beyond `intake-raw` (**sensitivity routing**, voice intake, research intake, clip intake) is manual after init"
  - `docs/wiki/specs/cli.md:113` — lint report writes to `inbox/review/...` "if the vault has `inbox/review/` configured (**the default for vaults with sensitivity routing enabled**)"
  - `docs/wiki/specs/sdk-surface.md:134` — "**Sensitive content writes to `inbox/review/<file>.md`**; ingest writes to `wiki/<type>/<name>.md`..." (under "Tool catalog (the seven)", a normative section)
  - `docs/wiki/specs/mcp-surface.md:58` — `write_document` input schema retains `opts?: { create?, reason?, sensitivity_classified? }` (divergent from `sdk-surface.md`, which drops the parameter)
- **Recommended fix:** Sweep the four sites: cli.md line 36 drops "sensitivity routing"; cli.md line 113 rewrites the conditional to remove the sensitivity reference; sdk-surface.md line 134 drops the sensitive-content sentence; mcp-surface.md line 58 drops `sensitivity_classified` from the MCP schema.
- **Substrate artifact to add or update:** spec (cli.md, sdk-surface.md, mcp-surface.md)

### B2. `AGENTS.md` contract contradicts the non-primary MCP stance

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** `AGENTS_MD_IS_ORIENTATION_SURFACE` is one of the four load-bearing surfaces of the new compiler-boundary contract. If its content prescription itself depends on MCP being mounted, the surface is broken precisely when the reframe says it should work. A future contributor would not know whether non-MCP harnesses get system rules at all.
- **Evidence:** `docs/wiki/specs/cli.md:30` — `AGENTS.md` "Carries cold-start orientation: how to mount Dome's MCP server, the minimum rules to honor when MCP isn't mounted, a pointer to `docs/wiki/invariants/`... **System rules deliberately live OFF this file — the MCP server delivers them as `instructions` at mount time** (see [[wiki/specs/mcp-surface]] §"Session model")." Combined with `AGENTS_MD_IS_ORIENTATION_SURFACE.md:13-15` which says AGENTS.md teaches "vault's conventions, page types, named workflows, **invariant set**" — and harnesses.md positions AGENTS.md for harnesses that do NOT mount MCP. If MCP delivers the system rules, non-MCP harnesses (the primary case under the reframe) don't get them.
- **Recommended fix:** Drop "System rules deliberately live OFF this file" from cli.md line 30. AGENTS.md carries system rules / invariant set as templated content (matching the new invariant doc's claim); MCP `instructions` becomes the secondary delivery for harnesses that also mount MCP.
- **Substrate artifact to add or update:** spec (cli.md `dome init`)

### B3. CLI command count drifts three ways

- **Severity:** High
- **Category:** Domain model / Spec drift
- **Why it matters:** "How many CLI commands does Dome ship?" is a foundational fact a contributor reads cold; three divergent answers across two specs is exactly the inventory-count drift the rubric flags. The summary table at cli.md:248 is the document a contributor scans for the canonical list — if it omits `dome stats`, an extension proposal could collide with it.
- **Evidence:**
  - `docs/wiki/specs/cli.md:12` — "**Eight commands**"
  - `docs/wiki/specs/cli.md:248` — table titled "The 7 commands map cleanly to user actions" enumerates 7 (omits `dome stats`, which has its own full section at line 176)
  - `docs/index.md:9` — "The **7-command** Dome CLI: init, migrate, serve, reconcile, lint, doctor, export-context" (omits both `dome stats` and the actual count)
- **Recommended fix:** Pick 8 (init, migrate, serve, reconcile, lint, doctor, stats, export-context) — the body of cli.md describes all 8. Update cli.md line 248 table to include `dome stats`; update index.md line 9 to "The 8-command Dome CLI" with `stats` in the list.
- **Substrate artifact to add or update:** spec (cli.md), index

### B4. Preamble file-rewrite count diverges from the body

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** The ledger's `## Delta at a glance` preamble is quoted verbatim into this validation review and into future ledger-viewer consumers. A preamble claiming "13 rewritten" against a body listing 18 means downstream readers will see a number that does not match the actual rewrite. The design-delta-ledger template §"Consumer rendering rules" names this divergence as a Blocking Issue against the template.
- **Evidence:** Ledger preamble line 15: "**Files:** 13 rewritten, 4 added (2 invariants, 1 gotcha, 1 ledger), 3 removed". Body `## Files rewritten` enumerates 18 entries.
- **Recommended fix:** Update the preamble to "18 rewritten".
- **Substrate artifact to add or update:** design delta ledger preamble

## Important issues

### I1. `hooks.md` shipped-defaults section names two; `intake-raw` is the third

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** A reader scanning `hooks.md` §"Shipped default hooks" learns there are two shipped-defaults (`auto-update-index`, `auto-cross-reference`). `intake-raw` is described in a different section as also shipped-default, and `sdk-surface.md`'s tiered-feature-model table lists three shipped-default hooks. A new contributor adding a hook wouldn't know whether the bar for shipped-default is 2 or 3.
- **Evidence:** `docs/wiki/specs/hooks.md:96-132` (the §"Shipped default hooks" section); compare `docs/wiki/specs/sdk-surface.md:271` and `docs/wiki/specs/hooks.md:140-145` (intake-raw row marked "shipped default" in the intake-patterns table).
- **Recommended fix:** Extend hooks.md §"Shipped default hooks" with a third subsection naming `intake-raw`, or add a leading paragraph naming all three and link to the intake-patterns table.
- **Substrate artifact to add or update:** spec (hooks.md)

### I2. `harnesses.md` per-harness setup file path is non-normative + vague

- **Severity:** Medium
- **Category:** Vague language
- **Why it matters:** Normative spec section points to documents that may not exist ("documented in `docs/wiki/sources/<harness>-setup.md` ... as the ecosystem stabilizes"). A contributor would not know whether to create these now or wait.
- **Evidence:** `docs/wiki/specs/harnesses.md:62` — "Per-harness setup is documented in `docs/wiki/sources/<harness>-setup.md` (**not in this spec**) **as the ecosystem stabilizes**."
- **Recommended fix:** Either commit to the location and document the convention or move the sentence to a non-normative "Future-harness pressure" subsection.
- **Substrate artifact to add or update:** spec (harnesses.md)

### I3. `prompts-and-workflows.md` references undocumented tool `do-research`

- **Severity:** Low
- **Category:** Domain model
- **Why it matters:** "`do-research`" is not in the seven-tool catalog and not in any plugin Tool definition; reading this in context as a representative example, a contributor might mistake it for a real Tool name.
- **Evidence:** `docs/wiki/specs/prompts-and-workflows.md:169` — "prevents an `ingest` workflow from accidentally invoking `do-research`".
- **Recommended fix:** Replace with a real Tool name from the catalog (e.g., `deleteDocument`), or rephrase generically.
- **Substrate artifact to add or update:** spec (prompts-and-workflows.md)

## Substrate gaps

- **`dome init` AGENTS.md content template undefined** is already substrate-noted in the ledger §"Remaining ambiguity" — but B2 above shows the gap is load-bearing now, not deferrable. Tied to the AGENTS.md / MCP-non-primary contradiction; resolving B2 resolves this.
- **`dome serve` MCP flag undefined**: ledger §"Remaining ambiguity" #3 notes this, but the ambiguity makes it impossible to validate whether `dome serve` honors the non-primary stance. A `--no-mcp` (or equivalent) decision should be made before implementation.

## Locality concerns

The four-surface compiler-boundary contract is well-scoped: AGENTS.md / CLI / daemon / reconcile each have a dedicated spec and clear ownership. The two-ways-by-scope principle is rendered consistently across VISION, sdk-surface, EVERY_WRITE_IS_LOGGED, and VAULT_RECONCILES_AFTER_NATIVE_WRITE — that's load-bearing seam discipline. No premature centralization observed.

## Future-fit concerns

The mobile / desktop / web / voice future-harness pressure is correctly contained in non-normative `## Future-harness pressure` sections; no smuggling into v0.5 normative scope. `mcp-surface.md` §"When MCP re-earns its keep" is the right shape for retired-but-preserved substrate.

## Enforcement concerns

`AGENTS_MD_IS_ORIENTATION_SURFACE.md` names structural enforcement via `dome doctor` reporting drift, with a regression test proposed. The enforcement story depends on `dome doctor --repair` actually shipping, which is deferred to implementation — acceptable per the ledger but worth noting that the invariant carries no current automated check; until `--repair` lands, the invariant is reviewer-attention-enforced.

## Behavior knowable outside implementation?

For the four-surface compiler boundary: yes. For sensitivity-retirement: no — the surviving references mean a contributor reading cli.md would still think sensitivity routing is an activatable feature. B1 closes this gap.

## Vague language to tighten

- `docs/wiki/specs/harnesses.md:62` — "as the ecosystem stabilizes"
- `docs/wiki/specs/mcp-surface.md:120` — "the surface is preserved against future-pressure rather than for current value delivery" (acceptable in a deliberately-flagged non-primary section; not a defect)

No "should / will / TBD / TODO" found in normative sections beyond the above.

## Recommended repairs (ranked)

1. Sweep the four sensitivity references (B1) — single-file edits, mechanical.
2. Resolve the AGENTS.md / MCP-non-primary contradiction (B2) — AGENTS.md carries system rules / invariant set as templated content; drop the "System rules deliberately live OFF this file" sentence from cli.md.
3. Reconcile the CLI command count to 8 across `cli.md` (line 12 keep, line 248 table fix), `index.md` (B3).
4. Update the ledger preamble file-rewrite count from 13 to 18 (B4).
5. Extend `hooks.md` shipped-defaults section to name `intake-raw` (I1).
6. Tighten `harnesses.md:62` and `prompts-and-workflows.md:169` (I2, I3).

## What looked right

- The new `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axiom paired with the strengthened `EVERY_WRITE_IS_LOGGED`'s two-paths framing is the strongest move — it gives the compiler-boundary contract a concrete integrity story rather than leaving "reconciles eventually" as folklore.
- VISION.md §"Principles" #3 ("invariants enforced two ways, by scope") is exactly the right level of abstraction — it names the seam without prescribing implementation.
- `out-of-band-vault-edits.md`'s upgrade from "tolerated workaround" to "canonical path" with a status note preserving the historical term `vault.out-of-band-edit` is the right move for a scar that needs reframing without losing search anchors.
