---
type: gotcha
created: 2026-05-26T00:00:00.000Z
updated: 2026-05-29T00:00:00.000Z
sources:
  - '[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]]'
coverage: off-matrix
enforced_at: tests/integration/no-retired-symbol-names-in-specs.test.ts
enforced_at_status: deferred
first_observed: 2026-05-26T00:00:00.000Z
severity: medium
---

# substrate-count-drift

**Symptom:** A synthesis doc, plan doc, or prose paragraph in a spec inlines a count of substrate items ("12 invariants", "9 workflow prompts", "5 CLI commands") that diverges from the canonical const array, registry, or filesystem inventory the spec actually depends on. A reader landing on the stale doc internalizes a wrong count and may build downstream decisions on the wrong number.

**Severity:** Medium — individually low-impact (a count drift rarely breaks anything load-bearing), but the pattern compounds. Phase A of the cohesion review found three independent live drifts: the foundation delta ledger's invariant tier counts (claimed 10, real 12), `v0.5-build-plan.md`'s CLI command count (claimed 5, real 7), and the same plan's workflow count (claimed 8, real 9). Each was correct at the time the inline number was written; each became wrong as the substrate grew.

**Root cause:** Inline counts age silently. The canonical surface (an `INVARIANTS` const, a `TOOL_NAMES` tuple, a filesystem directory) has a single source of truth that updates with the code; the synthesis doc's prose copy doesn't. There's no symmetric grep that flags "this number disagrees with that array" unless someone notices manually.

**Structural mitigation:** The **link-to-canonical-surface convention.** Phase A's spec rewrite established it: instead of writing `(5 CLI commands)`, write `the shipped command surface (canonical list: [[wiki/specs/cli]] §"Implementation note")`. The reader follows the link to the canonical inventory; the inline count vanishes. Phase B formalizes the convention as substrate.

The deferred `dome.health.check-substrate-counts` view-phase or scheduled garden-phase processor (v1.x, in the deferred `dome.health` bundle) parses spec prose for inlined counts that cite a canonical surface (e.g., "12 invariants per `INVARIANTS`") and compares against the actual const, emitting a DiagnosticEffect on drift. Surface via `dome inspect diagnostics --code substrate-count-drift`. v0.5 ships the convention but not the check; v1.x may add it if substrate growth makes manual link-checking expensive.

**Specific scenarios:**

- **Synthesis doc grows stale across a feature add.** `v0.5-build-plan.md` was written before pass-5 of the v0.5 foundation rewrite added `INDEX_AND_LOG_ARE_DISPATCHER_OWNED` as a 6th axiom; the plan's "10 invariants" line wasn't updated. The link-to-canonical fix (`canonical list: docs/wiki/invariants/`) makes the count derive from filesystem on read instead of inline copy.
- **Brainstorm doc inherits an old count from an earlier reviewer's mental model.** A brainstorm-design output from week 1 cites "the seven Tools" but week 4's design adds an 8th. If the brainstorm landed as substrate (not just a session artifact), the inline count rots.
- **Delta ledger's "Updated substrate counts" table goes stale across passes.** The foundation ledger's table at `docs/cohesive/delta-ledgers/2026-05-25-dome-v0.5-foundation.md` was correct at "after durability pass" but missed passes 4 and 5. Phase A's spec rewrite added a "Final (post pass-5)" column rather than silently updating mid-rewrite numbers; the audit trail is preserved.

**Operational notes:**

- **The convention applies to inventory counts, not constraint counts.** "Four-concept core" stays — it's a design property, not an inventory tally. "Seven Tools" stays the same way — the seven is the design seal, named in the registry. The count-drift gotcha is specifically about counts that *tally items enumerated elsewhere*.
- **Append-only history docs are exempt from rewriting.** A delta ledger or brainstorm dated 2026-05-25 may carry a count that was correct then and isn't now. Don't rewrite history; add a "Final" column or footnote when the canonical state diverges.
- **Foreshadows itself.** The Phase A rewrite's foundation-ledger update added a canonical-inventories footer naming `INVARIANTS`, `TOOL_NAMES`, `WORKFLOW_NAMES` as ground truth. Phase B's gotcha doc is the substrate-shape pin for the convention that footer practiced.

**Related:**
- [[wiki/specs/cli]] §"The CLI surface" (canonical CLI commands)
- [[wiki/matrices/built-in-extensions-x-phase]] (canonical first-party bundle catalogue, including processors and command-triggered view processors)
- `wiki/invariants/` (canonical invariants — one markdown file per invariant)
- [[wiki/linters/no-retired-symbol-names]] — sister structural fence catching the related drift pattern (retired symbol names rather than count drift)
