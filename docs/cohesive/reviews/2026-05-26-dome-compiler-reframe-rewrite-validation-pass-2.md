# Rewrite Validation Review — Dome compiler reframe + sensitivity retirement

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-26
**Pass:** 2
**Subject:** Pass-2 review after pass-1 repair commit `62d3a40`.

**Verdict:** Issues Found

## Executive judgment

The rewrite is structurally coherent: VISION's two-surface-pattern section, the new `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axiom, `AGENTS_MD_IS_ORIENTATION_SURFACE`, the upgraded out-of-band-edits gotcha, and the daemon-off gotcha together do the load-bearing work the brainstorm asked for. Where pass-1's blockers cleanly closed (sensitivity scrub, AGENTS.md contract, CLI command count, ledger preamble count), the repairs hold. What pass-1 did *not* sweep: the same compiler-vs-gateway reframe lives partially in three files — `cli.md`'s `dome serve` section still leads with MCP, `index.md`'s spec one-liner still says "how Claude Code mounts Dome via MCP," and `sdk-surface.md`'s §"Why this design" + Related list still carry the retired gateway claim. A future contributor reading those surfaces alone would get the pre-reframe story; reading the new surfaces alone would get the post-reframe story. The contradiction is local and repairable in one pass, but it's load-bearing enough to block.

## Delta at a glance

*(Quoted from ledger preamble — unchanged in pass-1 repairs except the file-rewrite count.)*

This rewrite is **Design**. 18 rewritten, 4 added, 3 removed. Conceptual changes: Dome's value-prop reframed around the *compiler* model; two-surface-pattern framing; AGENTS.md canonical orientation; MCP non-primary; sensitivity feature retired; inbox/review/ single-purpose; two-ways-by-scope invariant principle.

## Blocking issues

### B1. `cli.md` §"`dome serve`" still leads with MCP

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** The same file's command table at line 252 correctly describes `dome serve` as "Running the compiler daemon (watcher + reconcile + hooks; optional MCP server)" — but the canonical section for the command at lines 56-76 still opens with "Start the MCP server (and the intake-hook watcher daemon) for `<path>`." Step 3 of the startup order says "Starts the MCP server on stdio (or HTTP if `--port` is given)" — MCP is listed before the watcher. Line 76 says "For Claude Code integration, the harness spawns `dome serve --vault $VAULT` as a child process" — exactly the gateway-shaped framing the reframe retired (Claude Code does not spawn `dome serve`; the user runs it as a launchd / systemd service per the rewrite). A contributor reading this section sees the pre-reframe story; a contributor reading the table at line 252 sees the post-reframe story. The two stories cannot both be true.
- **Evidence:**
  - `cli.md:56` — "Start the MCP server (and the intake-hook watcher daemon) for `<path>`."
  - `cli.md:69` — "Starts the MCP server on stdio (or HTTP if `--port` is given)" listed as step 3, before "Starts the file watcher" at step 4.
  - `cli.md:76` — "For Claude Code integration, the harness spawns `dome serve --vault $VAULT` as a child process."
  - `cli.md:262` — Related list: "`dome serve` starts this" pointing at mcp-surface.
  - `cli.md:264` — Related list: "`dome serve` is what harnesses connect to" pointing at harnesses.
- **Recommended fix:** Rewrite the §"`dome serve`" intro to "Start the compiler daemon (watcher + reconcile + hooks; optionally also the MCP server) for `<path>`." Reorder startup steps: 1. open vault; 2. auto-reconcile; 3. start watcher; 4. start scheduled-hook clock; 5. (optional) start MCP server when MCP is configured. Rewrite line 76 to name the launchd / systemd service deployment as primary and the harness-spawn pattern as the optional MCP path. Rewrite the two Related entries to reflect the compiler-boundary contract.
- **Substrate artifact to add or update:** spec (`cli.md` §"`dome serve`" + §"Related").

### B2. `index.md:10` describes harnesses.md with the retired gateway claim

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** `docs/index.md` is the catalog every reader hits first. Its one-line description of `harnesses.md` reads "How Claude Code, Cursor, and future native clients mount Dome via MCP" — exactly the framing the rewrite retired and harnesses.md now contradicts head-on. A future reader navigating from the index would form the pre-reframe model before reading the actual spec. The repair sweep updated invariant entries and gotcha entries in this index; the spec entries were not propagated.
- **Evidence:**
  - `index.md:10` — "[[wiki/specs/harnesses]] — How Claude Code, Cursor, and future native clients mount Dome via MCP."
  - `harnesses.md:14-23` (§"The compiler-boundary contract") — names AGENTS.md + CLI + daemon + reconcile as load-bearing; MCP demoted to "non-primary fifth surface."
- **Recommended fix:** Rewrite `index.md:10` to "How agentic harnesses (Claude Code, Cursor, future agents) interact with Dome via the compiler-boundary contract (AGENTS.md + CLI + daemon + reconcile); MCP available as a non-primary fifth surface."
- **Substrate artifact to add or update:** index (`docs/index.md`).

### B3. `sdk-surface.md` §"Why this design" still carries the gateway claim

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** The same file's §"Tool" at line 89-91 correctly scopes the gateway claim ("Every mutation *within Dome's own dispatcher / hook / workflow chain* flows through a Tool" + the explicit native-write paragraph). But §"Why this design" at line 421 still reads "**Invariants at the tool boundary, not in agent discipline.** A second brain that silently writes wrong claims corrupts the user's thinking… Every invariant in Dome is enforced *inside* the Tool that would otherwise violate it." That's the pre-reframe principle verbatim; it contradicts the new `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axiom and the two-ways-by-scope framing in VISION §"Principles" #3. The §"Related" list at line 433 still says "harnesses — how Claude Code and others mount Dome via MCP." A reader who scrolls to §"Why this design" — the section that justifies the architecture — finds the retired claim presented as the canonical defense.
- **Evidence:**
  - `sdk-surface.md:421` — "**Invariants at the tool boundary, not in agent discipline.** … Every invariant in Dome is enforced *inside* the Tool that would otherwise violate it."
  - `sdk-surface.md:425` — "small core (four concepts) + structural enforcement at the boundary (invariants in Tools) + behavior as readable prose (prompts as contract)" — still names "invariants in Tools" unqualified.
  - `sdk-surface.md:433` — Related: "harnesses — how Claude Code and others mount Dome via MCP."
- **Recommended fix:** Rewrite the second principle to "**Invariants are enforced two ways, by scope.**" — restate the internal-scope (Tool-mediated) and external-scope (watcher + reconcile) framing from VISION §"Principles" #3 here, cite the new `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axiom alongside `HOOKS_CANNOT_BYPASS_TOOLS`. Update line 425's three-principles summary to match. Rewrite the Related entry for harnesses to "the compiler-boundary contract harnesses consume."
- **Substrate artifact to add or update:** spec (`sdk-surface.md` §"Why this design" + §"Related").

### B4. `prompts-and-workflows.md:39` workflow frontmatter example references "route sensitive"

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** The canonical workflow-frontmatter example — the shape an implementer or plugin author would copy when registering a new workflow — carries `description: "Process a new raw source: extract atoms, match to pages, propose updates, route sensitive, log."`. The retired sensitivity feature lives on in the spec's authoritative example. A future contributor reads this as the canonical `ingest` description and either (a) re-implements sensitivity routing in `ingest` because the spec told them to, or (b) gets confused about what the description means. Pass-1's sensitivity sweep missed this surface.
- **Evidence:** `prompts-and-workflows.md:39` — `description: "Process a new raw source: extract atoms, match to pages, propose updates, route sensitive, log."`
- **Recommended fix:** Rewrite the description to "Process a new raw source: extract atoms, match to pages, propose updates, log."
- **Substrate artifact to add or update:** spec (`prompts-and-workflows.md` §"Workflow frontmatter" example).

## Important issues

### I1. `hooks.md:162` sync-opt-in example cites a retired-feature pattern

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** Sync-opt-in is described as "Reserved for hooks that must complete before downstream code observes the result — e.g., a classifier that gates a write destination, or any future hook with a hard pre-write contract." The "classifier that gates a write destination" is the canonical example of the retired sensitivity-classify feature.
- **Evidence:** `hooks.md:162` — "Reserved for hooks that must complete before downstream code observes the result — e.g., a classifier that gates a write destination, or any future hook with a hard pre-write contract."
- **Recommended fix:** Replace the classifier example with a non-retired one: "a frontmatter-shape validator that gates the write," or "a quota-check hook that gates whether the write proceeds."
- **Substrate artifact to add or update:** spec (`hooks.md` §"Execution model").

### I2. `vault-layout.md` `inbox/review/` shipped-default vs opt-in inconsistency

- **Severity:** Medium
- **Category:** Domain model
- **Why it matters:** Line 33 names `review/` as "shipped-default destination (NOT an intake) — created by `dome init`." Line 46 says "Additional `inbox/<bucket>/` directories (`voice/`, `research/`, `clip/`, `review/`) exist only when the vault activates the corresponding intake hook template." The two statements disagree.
- **Evidence:**
  - `vault-layout.md:33` — "review/ # shipped-default destination (NOT an intake) — created by `dome init`"
  - `vault-layout.md:46` — "Additional `inbox/<bucket>/` directories (`voice/`, `research/`, `clip/`, `review/`) exist only when the vault activates…"
- **Recommended fix:** Drop `review/` from the opt-in list at line 46.
- **Substrate artifact to add or update:** spec (`vault-layout.md` §"Vault root").

### I3. Delta ledger §"How to read this ledger" line 252 still says "13 files rewritten"

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** Pass-1's B4 closed the preamble's "13 → 18" drift, but the closing reader walk at line 252 still says "13 files rewritten." Same drift sibling section.
- **Evidence:** delta-ledger line 252 — "broad design rewrite (13 files rewritten, 4 added, 3 removed)"
- **Recommended fix:** Update line 252 to "18 files rewritten" to match the preamble.
- **Substrate artifact to add or update:** ledger (`docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md` §"How to read this ledger").

## Substrate gaps

- **No spec or matrix names the `dome.system_prompt` + AGENTS.md relationship.** Substrate-note worthy, not blocking.

## Recommended repairs (ranked)

1. B1: cli.md §"`dome serve`" — rewrite lead, reorder startup steps, fix Related entries.
2. B2: index.md:10 — one-line edit.
3. B3: sdk-surface.md §"Why this design" — rewrite principle #2; update three-principles summary; fix Related entry.
4. B4: prompts-and-workflows.md:39 — one-line edit.
5. I1, I2, I3 — three small edits.

## What looked right

- Pass-1's B-class repairs cleanly closed and held under fresh-eyes re-review (sensitivity scrub on the 4 named sites, AGENTS.md contract rewrite, CLI command count, ledger preamble count). The pattern of repairs landing didactically (each finding cited by ID in commit + ledger) makes pass-2's audit trail easy to verify.
- The compiler-vs-gateway framing in the four spots pass-2 caught is each a *local* surface that didn't get swept; none of them indicates the design itself is unsound. Each is a one-or-two-line edit.
- The ledger's §"Repair pass 1" section is exactly the substrate-shape record the design-delta-ledger template promises — a fresh-eyes reviewer can audit which findings closed and how.
