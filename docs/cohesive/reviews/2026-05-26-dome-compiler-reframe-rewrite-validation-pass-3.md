# Rewrite Validation Review — Dome compiler reframe + sensitivity retirement

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-26
**Pass:** 3
**Subject:** Pass-3 review after pass-2 repair commit `e8f2f5c`.

**Verdict:** Issues Found

## Executive judgment

The rewrite lands the compiler reframe cleanly across the principal surfaces — VISION, harnesses, sdk-surface §"Tool", mcp-surface preamble, cli §"`dome serve`", and the two new invariants are mutually coherent and read as end-state. The two-ways-by-scope framing is now load-bearing in three connected places (VISION #3, sdk-surface §"Why this design" #2, `VAULT_RECONCILES_AFTER_NATIVE_WRITE`) and a future contributor can reconstruct the architecture from those alone. **One Blocker remains:** sdk-surface.md §"Tiered feature model" still lists `MCP server` in the Axiom row alongside the seven Tools and CLI — directly contradicting mcp-surface.md's non-primary stance and the ledger's demotion. A fresh reader hitting that table reads "disabling MCP changes what Dome is" and is told the opposite on every other normative surface. Three High/Medium drag-along issues are stale section-name references and one residue inconsistency about `inbox/raw/` activation status.

## Blocking issues

### B1. MCP listed as Axiom contradicts the non-primary demotion across the rest of the rewrite

- **Severity:** Blocker
- **Category:** Spec drift
- **Why it matters:** The whole rewrite's load-bearing move is demoting MCP from "the canonical mount point" to a "non-primary, preserved-for-future-pressure surface" — explicit in VISION.md, mcp-surface.md's status preamble, harnesses.md's compiler-boundary contract, cli.md's `dome serve` rewrite, and the ledger's Conceptual-changes table. But sdk-surface.md §"Tiered feature model" still names `MCP server` in the Axiom row — defined immediately above as "Cannot be disabled. Disabling them changes what Dome is." A fresh reader landing on that table is told MCP is structurally required to *be* Dome, while every other normative surface tells them MCP is optional and not load-bearing in v0.5. They cannot tell from the docs which claim is canonical.
- **Evidence:** `docs/wiki/specs/sdk-surface.md:270` — Axioms row reads: "The axiom-tier invariants (canonical list: …). The 7 Tools. `index.md` + `log.md`. **MCP server.** CLI commands." Contrast with `docs/wiki/specs/mcp-surface.md:10` — "**Status in v0.5: non-primary surface.**" And `docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md` Conceptual-changes row: "MCP as the canonical mount point | MCP as a non-primary, preserved-for-future-pressure surface | Demoted."
- **Recommended fix:** Move `MCP server` out of the Axiom row. Cleanest: drop it from the table entirely — MCP is a *consumer-surface choice*, not an "invariant/feature on/off" tier — and add a one-line footnote naming MCP as "preserved code surface, non-primary in v0.5 per [[wiki/specs/mcp-surface]] §'Status in v0.5'".
- **Substrate artifact to add or update:** `docs/wiki/specs/sdk-surface.md` §"Tiered feature model".

## Important issues

### I1. Stale section-name links to `§"Opt-in intake patterns"` after the section rename

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** `hooks.md` §"Intake patterns — shipped-default and opt-in" was renamed in this rewrite. Three other docs still link to the old section name. A future contributor following the link finds nothing at the cited anchor.
- **Evidence:**
  - `docs/wiki/concepts/brain-companion.md:27` — "See [[wiki/specs/hooks]] §'Opt-in intake patterns.'"
  - `docs/wiki/specs/vault-layout.md:46` — "see [[wiki/specs/hooks]] §'Opt-in intake patterns.'"
  - `docs/wiki/invariants/INBOX_IS_EPHEMERAL.md:49` — Related list: "[[wiki/specs/hooks]] §'Opt-in intake patterns' and §'Durability and reconciliation'"
  - Target: `docs/wiki/specs/hooks.md:136` — current heading "## Intake patterns — shipped-default and opt-in"
- **Recommended fix:** Rewrite each citation to point at `§"Intake patterns — shipped-default and opt-in"`.
- **Substrate artifact to add or update:** Three spec edits.

### I2. `brain-companion.md`'s quick-capture bullet contradicts the shipped-default status of `inbox/raw/`

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** `brain-companion.md:27` says "Quick-capture is a file write to `inbox/raw/` (when activated)." The "(when activated)" hedge implies opt-in. But `inbox/raw/` + `intake-raw` are shipped-default. A reader who lands on the concept doc first reads "when activated" and assumes the user has to enable raw capture.
- **Evidence:** `docs/wiki/concepts/brain-companion.md:27` — "Quick-capture is a file write to `inbox/raw/` (when activated)."
- **Recommended fix:** Drop "(when activated)" — `inbox/raw/` is shipped-default and works out of the box.
- **Substrate artifact to add or update:** One-line spec edit to `brain-companion.md:27`.

### I3. mcp-surface.md §"Invocation" hedges HTTP transport with "once a use case demands it"

- **Severity:** Low
- **Category:** Vague language
- **Why it matters:** `mcp-surface.md:47` carries a "once a use case demands it" hedge in a normative section. The §"Why MCP is the only protocol-server surface" section already names HTTP REST/SSE as deferred without a hedge; this duplicates and softens.
- **Evidence:** `docs/wiki/specs/mcp-surface.md:47` — "v0.5 ships stdio first; HTTP follows in v0.5.1 once a use case demands it."
- **Recommended fix:** Replace with a concrete deferral pointer: "v0.5 ships stdio; HTTP/SSE is deferred — see §'Why MCP is the only protocol-server surface in v0.5'."
- **Substrate artifact to add or update:** One-line spec edit.

## Recommended repairs (ranked)

1. B1 — Move MCP out of the Axioms tier in sdk-surface.md.
2. I1 — Update three §"Opt-in intake patterns" links.
3. I2 — Drop "(when activated)" from brain-companion.md.
4. I3 — Replace the "once a use case demands it" hedge.

## What looked right

- **The two-ways-by-scope framing is genuinely structural** across five surfaces (VISION #3, sdk-surface §"Why this design" #2, HOOKS_CANNOT_BYPASS_TOOLS, VAULT_RECONCILES_AFTER_NATIVE_WRITE, EVERY_WRITE_IS_LOGGED). A future contributor confused by "do invariants gate at write-time?" reads any of the five and learns the right answer.
- **The `out-of-band-vault-edits` gotcha upgrade was the right call.** Reframing native writes from "tolerated workaround" to "canonical write path with structural machinery" is exactly the doc move the architecture demanded.
- **`AGENTS_MD_IS_ORIENTATION_SURFACE` carries its content contract honestly.** The templated-vs-user-prose split via HTML-comment delimiters, the `--repair` regeneration behavior, and the three proposed regression tests give the implementer enough to land the invariant without re-deriving intent.
