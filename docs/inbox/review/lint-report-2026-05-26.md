---
type: lint-report
created: '2026-05-26'
updated: '2026-05-26'
workflow: lint
pass: 3
---

# Lint report — 2026-05-26

Walk of `wiki/`, `index.md`, and adjacent docs. Findings ordered by severity. Each carries a stable id (`H<n>` / `M<n>` / `L<n>`) reusable across same-day passes; `(advisory)` tags mark findings that require human judgment outside the workflow's scope (apply mode refuses these).

## Pass 1

### H1. **`wiki/specs/cli.md` self-contradicts its CLI command count and final summary table omits `dome stats`** (HIGH)

**Evidence:** `wiki/specs/cli.md` opens (paragraph 2) with `**Eight commands**. Each maps to a concrete user action; commands that would map to "chat-with-the-brain" or "browse-the-vault" do not exist...` and proceeds to document eight `##` sections (`dome init`, `dome migrate`, `dome serve`, `dome reconcile`, `dome lint`, `dome doctor`, `dome stats`, `dome export-context`). But the file's closing summary table is introduced as `The 7 commands map cleanly to user actions:` and the table that follows lists only seven rows (`dome init`, `dome migrate`, `dome serve`, `dome reconcile`, `dome lint`, `dome doctor`, `dome export-context`) — `dome stats` is missing from both the lead-in count and the table body. This is the exact failure mode catalogued by `wiki/gotchas/substrate-count-drift.md` ("`v0.5-build-plan.md`'s CLI command count (claimed 5, real 7)" — a third generation of the same drift, now claimed-7 / real-8).

**Recommendation:** Rewrite `wiki/specs/cli.md`'s closing summary table section (the block immediately under `### Errors at the consumer-shell boundary` that begins `The 7 commands map cleanly to user actions:`) to read `The 8 commands map cleanly to user actions:` and insert a `dome stats` row into the table between the `dome doctor` row and the `dome export-context` row, with columns `dome stats` / `deterministic` / `Glance at vault structure and activity (page counts, link graph health, raw files, log activity, top hubs, git stats)`. Leave the opening `**Eight commands**` paragraph untouched (it is the correct anchor); the rewrite reconciles the closing table to it. No other section of the file needs to change — the `## dome stats` body section is already present and correct.

### H2. **`wiki/specs/sdk-surface.md` describes the CLI shell as exporting "the seven `dome*` command functions"** (HIGH)

**Evidence:** `wiki/specs/sdk-surface.md` under the `### Runtime` / `Distribution` section, in the `@dome/sdk/cli` bullet, reads `**CLI shell**. \`runCli\`, the seven \`dome*\` command functions, \`CliError\`, \`renderCliError\`, \`DoctorFlag\`.` The CLI spec at `wiki/specs/cli.md` documents eight `dome*` commands (init, migrate, serve, reconcile, lint, doctor, stats, export-context); the SDK surface's "seven" claim is a downstream copy of the same stale count that produced H1.

**Recommendation:** Edit `wiki/specs/sdk-surface.md` to replace `the seven \`dome*\` command functions` with `the \`dome*\` command functions (canonical list: [[wiki/specs/cli]] §"Implementation note")` — applying the link-to-canonical-surface convention mandated by `wiki/gotchas/substrate-count-drift.md` rather than substituting a new inline count that will rot the same way. The surrounding sentence stays intact; only the eight-word phrase changes.

### M1. **`index.md` describes the CLI spec as "The 7-command Dome CLI: init, migrate, serve, reconcile, lint, doctor, export-context" — same drift, dispatcher-owned page** (MEDIUM) (advisory)

**Evidence:** `index.md:9` reads `- [[wiki/specs/cli]] — The 7-command Dome CLI: init, migrate, serve, reconcile, lint, doctor, export-context.` This omits `dome stats` and asserts the same stale count this report's H1 catches in `cli.md`. `index.md` is dispatcher-owned per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]; `writeDocument` refuses writes to this path. The fix path is `dome doctor --rebuild-index` (which derives entries from `wiki/` content) or a dispatcher-side change to the index-entry template — neither is reachable from the `lint` workflow's bound tool set.

**Recommendation:** *(advisory — not auto-applicable.)* After H1 is applied (so `wiki/specs/cli.md` is the corrected canonical surface), run `dome doctor --rebuild-index` to regenerate `index.md` from current wiki state. If the rebuilt index-entry shape still inlines a count (the index-entry template may copy the spec's H1 summary line), open a follow-up to switch the index-entry generator to a link-to-canonical-surface phrasing consistent with the convention in `wiki/gotchas/substrate-count-drift.md`. The index template change lives in dispatcher code, not vault markdown, and is outside the lint workflow's scope.

### L1. **No orphans, no schema violations, no unresolved wikilinks detected in this pass** (LOW) (advisory)

**Evidence:** Walked all `wiki/*/` pages against `index.md`'s catalog. Every wiki page enumerated in `index.md` resolves; the catalog appears in sync with filesystem inventory. Frontmatter `type:` matches directory across the sample inspected (`wiki/specs/cli.md` → `type: spec`, `wiki/gotchas/substrate-count-drift.md` → `type: gotcha`, `wiki/matrices/consumer-surface.md` → `type: matrix`, etc.). The `[[wiki/entities/x]]` and `[[x]]` strings appearing inside `index.md`'s `WIKILINKS_ARE_FULLPATH` description are syntax illustrations, not real wikilinks (they live inside the human-readable gloss of the invariant entry and are correct as illustrative tokens).

**Recommendation:** *(advisory — informational, no action.)* No mutation. Recorded for the longitudinal log so future passes can compare against this baseline.

---

## Summary

- **Applicable** (apply mode will execute): `H1`, `H2`
- **Advisory** (apply mode will refuse): `M1`, `L1`

Re-invoke with `dome lint --apply H1 H2` to fix the two count-drift drifts in `cli.md` and `sdk-surface.md`. The advisory findings are recorded here for the longitudinal log and require human attention separately.

## Pass 2

Pass 2 adds three findings discovered on a re-walk. The Pass-1 findings above (`H1`, `H2`, `M1`, `L1`) remain open — none carry an `Applied:` annotation; the propose-then-apply gate has not yet been crossed. They are not re-surfaced here because the ids are stable across passes; apply `dome lint --apply H1 H2` against the Pass-1 entries directly.

Pass 2 also re-classifies the `[[wiki/entities/x]]` / `[[x]]` situation that Pass-1's `L1` recorded as benign: see `M2` below. The two passes disagree on whether those tokens are illustrative-and-harmless vs parsed-as-broken-links; the disagreement is the longitudinal-log value of same-day re-runs.

### M2. **`index.md`'s `WIKILINKS_ARE_FULLPATH` description embeds two literal wikilinks (`[[wiki/entities/x]]` and `[[x]]`) that DO parse as real links and pollute `linksOut`** (MEDIUM) (advisory)

**Evidence:** `index.md` under `## Invariants`, the bullet for `WIKILINKS_ARE_FULLPATH`, reads `[[wiki/invariants/WIKILINKS_ARE_FULLPATH]] — *(shipped default)* [[wiki/entities/x]] not [[x]].` The `[[wiki/entities/x]]` and `[[x]]` tokens are intended as illustrative syntax (mirroring the invariant's `**Statement:**` field in `wiki/invariants/WIKILINKS_ARE_FULLPATH.md`), but Dome's wikilink parser does not distinguish illustrative from referential — both tokens appear in `index.md`'s `linksOut` (verified by `readDocument` against `index.md`: `linksOut` contains entries `{raw: "[[wiki/entities/x]]", target: "wiki/entities/x", isFullPath: true}` and `{raw: "[[x]]", target: "x", isFullPath: false}`). `wikilinkResolve("wiki/entities/x")` returns `null`; `wikilinkResolve("x")` returns `null`. The `[[x]]` form additionally fails [[wiki/invariants/WIKILINKS_ARE_FULLPATH]] itself — a short-form link in the catalog of the very invariant that forbids them. `dome doctor` will surface both as unresolved-link warnings and `[[x]]` as a fullpath-violation warning, indefinitely. Pass-1's `L1` recorded this as harmless illustration; Pass-2 disagrees — the structural-health surface treats them as real.

**Recommendation:** *(advisory — `index.md` is dispatcher-owned per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]] and `writeDocument` refuses this path; apply mode cannot execute.)* When the dispatcher's index-entry generator next renders this entry (or via `dome doctor --rebuild-index`), the `WIKILINKS_ARE_FULLPATH` one-liner should be rephrased so the example tokens do not parse as wikilinks. Proposed phrasing: `[[wiki/invariants/WIKILINKS_ARE_FULLPATH]] — *(shipped default)* Wikilinks use the full path from vault root (e.g., the full path under wiki/entities/ rather than the bare slug).` The example is described in prose; no bracketed examples remain in the index body. Alternatively, the index-entry template could escape illustrative wikilinks (e.g., backticking them: `` `[[wiki/entities/x]]` `` ) — a one-line dispatcher fix that would also save the `WIKILINKS_ARE_FULLPATH` invariant page (which contains the same illustrative tokens in its body and presumably suffers the same pollution; see follow-up below).

**Follow-up surface** (not its own finding — recorded here for cross-reference): `wiki/invariants/WIKILINKS_ARE_FULLPATH.md` paragraph `**Statement:**` also embeds `[[wiki/entities/danny]]` and `[[danny]]` and `[[Danny]]` as illustrative tokens. `wiki/entities/danny` does not exist; `[[danny]]` and `[[Danny]]` are short-form. Same parser-doesn't-distinguish issue; same dispatcher-owned blast radius is wider. The structural fix (backtick illustrative wikilinks throughout the invariants catalog, or invent a `<!-- noindex -->` HTML-comment fence the parser respects) is a substrate-level change deserving its own design pass — out of scope for an apply.

### M3. **Broken wikilink `[[wiki/invariants/]]` in `wiki/specs/sdk-surface.md` — trailing-slash directory reference parsed as link** (MEDIUM)

**Evidence:** `wiki/specs/sdk-surface.md` §"Tiered feature model", in the Axioms row of the tier table, contains: `The axiom-tier invariants (canonical list: [[wiki/invariants/]] filtered by \`tier: axiom\`; \`src/types.ts\` \`INVARIANTS\` for the typed const).` The `[[wiki/invariants/]]` token is parsed as a wikilink (confirmed: it appears in `wiki/specs/sdk-surface.md`'s `linksOut` as `{raw: "[[wiki/invariants/]]", target: "wiki/invariants/", isFullPath: true}`), but `wikilinkResolve("wiki/invariants/")` returns `null` — no page exists at that path; the author meant the directory. `dome doctor` will flag this as an unresolved link. No other occurrences of the `[[wiki/invariants/]]` shape exist in the vault.

**Recommendation:** In `wiki/specs/sdk-surface.md`, locate the substring `canonical list: [[wiki/invariants/]] filtered by \`tier: axiom\`` (inside the Axioms-tier row of the "Tiered feature model" markdown table) and replace it with `canonical list: the \`wiki/invariants/\` directory filtered by \`tier: axiom\``. Drop the brackets; describe the directory in prose with a backticked path. The semantic intent is preserved; the broken wikilink is removed. This is a single-character-class edit within one table cell — `writeDocument` with the same frontmatter; only the body cell changes.

### L2. **`wiki/syntheses/v0.5-build-plan.md` cites `[[VISION]] §"Long term"` but `VISION.md` has no heading literally titled "Long term"** (LOW) (advisory)

**Evidence:** `wiki/syntheses/v0.5-build-plan.md` §"Long-term — Always-with-you" opens: `The vision (from [[VISION]] §"Long term"): ambient, always there, low-friction.` Reading `VISION.md`: the relevant H2 is `## Shape over time`, inside which a paragraph leads with the bolded phrase `**Long term.**` — a paragraph lead-in, not a markdown heading anchor. A reader following the `§"Long term"` cite to a heading will not find one; Obsidian's section-anchor follow will fail.

**Recommendation:** *(advisory — choice between two plausible fixes requires authorial judgment.)* Either (a) rewrite the cite in `wiki/syntheses/v0.5-build-plan.md` from `[[VISION]] §"Long term"` to `[[VISION]] §"Shape over time"` (the actual H2; lightest touch, leaves north-star untouched), or (b) promote `**Long term.**` inside `VISION.md` to its own `### Long term` subheading inside `## Shape over time` (matches the cite shape but mutates the vision doc). The author should pick; both are reasonable. Marked advisory because mutating `VISION.md` is high-trust and the alternative is editorial-not-mechanical.

---

## Pass 2 summary

- **New applicable** (apply mode will execute): `M3`
- **New advisory** (apply mode will refuse): `M2`, `L2`
- **Still open from Pass 1** (carry-over, no annotation yet): `H1`, `H2` (applicable); `M1`, `L1` (advisory)

Re-invoke with `dome lint --apply H1 H2 M3` to land the three executable fixes in one pass.

## Pass 3

Pass 3 re-walked the vault and confirms every Pass-1 / Pass-2 finding remains open — none carry an `Applied:` annotation, and the on-disk surfaces they cite are byte-identical to what was quoted in the prior passes (re-read `wiki/specs/cli.md`, `wiki/specs/sdk-surface.md`, `index.md` to verify). Pass 3 adds one new finding (`H3`) that is the *same drift family* as `H1` / `H2` / `M1` — a third site in `cli.md` itself that omits `dome stats` from the deterministic / LLM-driven classification. This finding was not surfaced in Pass 1 or Pass 2 because attention was focused on the closing-table site; the "Implementation note" prose is its own self-contained classification that the closing-table fix won't touch.

### H3. **`wiki/specs/cli.md` §"Implementation note" classification omits `dome stats` from both the deterministic and LLM-driven command lists** (HIGH)

**Evidence:** `wiki/specs/cli.md` §"Implementation note" (the section above the closing summary table that `H1` targets) reads in full: `CLI commands implement to a single pattern: parse args, open the vault, dispatch to either (a) a Tool sequence (deterministic: \`init\`, \`doctor\`, \`serve\`, \`reconcile\`) or (b) a workflow via the headless agent loop (LLM-driven: \`migrate\`, \`lint\`, \`export-context\`). The CLI itself is < 600 LOC; most of the work lives in the workflows and Tools.` The two lists enumerate 4 + 3 = 7 commands; `dome stats` is absent from both. The `## dome stats` body section earlier in the file explicitly tags stats as `No LLM; deterministic; safe to run anywhere \`dome doctor\` is safe.`, so the missing-command's correct bucket is unambiguous: deterministic. This is the same `dome stats`-omission drift `H1` catches in the closing table and `H2` catches in `sdk-surface.md` — three independent sites of the same forgotten-on-introduction omission; `wiki/gotchas/substrate-count-drift.md` predicts exactly this pattern (counts inlined across many pages drift independently). Other consumers of this list (`wiki/syntheses/v0.5-build-plan.md` already links to `[[wiki/specs/cli]] §"Implementation note"` as the canonical list — see the v0.5 build-plan's Ships bullet `- CLI: the shipped command surface (canonical list: [[wiki/specs/cli]] §"Implementation note").`), which means an "Implementation note" that omits `dome stats` silently mis-informs the synthesis doc's downstream readers.

**Recommendation:** In `wiki/specs/cli.md` §"Implementation note", edit the parenthetical command lists so the deterministic list reads `(deterministic: \`init\`, \`doctor\`, \`serve\`, \`reconcile\`, \`stats\`)` and the LLM-driven list stays `(LLM-driven: \`migrate\`, \`lint\`, \`export-context\`)`. Specifically: locate the sentence beginning `CLI commands implement to a single pattern: parse args, open the vault, dispatch to either (a) a Tool sequence` and replace the substring `(deterministic: \`init\`, \`doctor\`, \`serve\`, \`reconcile\`)` with `(deterministic: \`init\`, \`doctor\`, \`serve\`, \`reconcile\`, \`stats\`)`. Single-token insertion inside one parenthetical; no other prose changes. Pairs with `H1` (closing table) to reconcile every inlined command list in `cli.md` to the eight-command reality the file opens with.

---

## Pass 3 summary

- **New applicable** (apply mode will execute): `H3`
- **Still open from Pass 1 / Pass 2** (carry-over, no annotation yet): `H1`, `H2`, `M3` (applicable); `M1`, `L1`, `M2`, `L2` (advisory)

Re-invoke with `dome lint --apply H1 H2 H3 M3` to land the four executable fixes (three count-drift sites in `cli.md` + `sdk-surface.md`, plus the broken `[[wiki/invariants/]]` link). The advisory findings remain recorded for the longitudinal log and require human attention separately.
