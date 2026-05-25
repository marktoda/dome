# Dome design substrate — Log

Append-only chronological record of operations on this vault. Each entry is parseable with `grep "^## \[" log.md`.

Verbs: `bootstrap`, `ingest`, `update`, `query`, `lint`.

## [2026-05-25] bootstrap | Dome design substrate vault created

Restructured `docs/` from a flat layout into a Dome-shaped vault as part of the `dome-v0.5-foundation` design rewrite. This vault dogfoods Dome on Dome — proof that the design generalizes from personal notes to project-design substrate.

**Created directories:**
- `raw/`, `notes/`
- `wiki/{entities,concepts,sources,syntheses,specs,invariants,matrices,gotchas}/`
- `.dome/{prompts,hooks}/`

**Moved:**
- `+` [[raw/original-architecture]] — was `docs/ARCHITECTURE.md`; preserved verbatim as the design seed. Frontmatter added (id, source_type: design-seed, status: preserved).

**Created (config):**
- `+` `.dome/page-types.yaml` — declares the four default page types + four extension types (spec, invariant, matrix, gotcha).
- `+` `.dome/config.yaml` — project-specific config: disables `PAGE_CREATION_REQUIRES_RECURRENCE` (specs/invariants are authored explicitly) and `SENSITIVE_GOES_TO_INBOX` (project vault, no sensitive personal content).

**Created (vault root):**
- `+` [[index]] — catalog of all wiki pages.
- `+` [[log]] — this file.

**Already at vault root from prior commit:**
- `VISION.md` — north-star vision; will be lightly updated in this rewrite to reference the four-concept core.

This bootstrap is the structural prerequisite for writing the substrate docs that compose the `dome-v0.5-foundation` rewrite. The design delta ledger at [[../cohesive/delta-ledgers/2026-05-25-dome-v0.5-foundation]] documents every change.

## [2026-05-25] update | Simplification pass — 4 collapses

Mid-rewrite simplification pass driven by user pressure-testing the just-written substrate. Four concrete collapses:

1. **Concept folder 8 → 2.** Folded 6 redundant concepts (`four-concept-core`, `hook-extensibility`, `prompts-as-contract`, `invariants-at-tool-boundary`, `agent-harness-agnostic`, `drop-zone-intake`) into "Why this design" sections of corresponding specs. Kept [[wiki/concepts/brain-companion]] (product framing) and [[wiki/concepts/llm-wiki-pattern]] (external pattern reference).
2. **Tool catalog 10 → 6.** Dropped `routeSensitiveToInbox` (writePage to inbox/review/ suffices), `doResearch` (research is a workflow), `proposeLintFixes` (lint is a workflow), `updateIndex` (now a shipped default hook on document.written.wiki.*), `appendRawLinkedPage` (linked-pages is derivable; the RAW_IS_IMMUTABLE exception is gone).
3. **Three-tier feature model + opt-in features.** Established axioms (cannot disable) vs shipped defaults (opt-out) vs opt-in (activate-explicit). `SENSITIVE_GOES_TO_INBOX` and `PAGE_CREATION_REQUIRES_RECURRENCE` reframed as opt-in. `inbox/<bucket>/` directories are not pre-created by `dome init`; users activate intakes by adding hook YAMLs. The `dome init --kind <profile>` flag was considered and rejected — `dome init` stays minimal and general-purpose.
4. **`PROMPTS_ARE_CONTRACT` retired as an invariant.** Moved to `[[wiki/specs/sdk-surface]]` §"Why this design" as an architectural design principle (not a per-vault enforceable rule).

- `-` [[wiki/concepts/four-concept-core]] (folded into sdk-surface §"Why this design")
- `-` [[wiki/concepts/hook-extensibility]] (folded into hooks)
- `-` [[wiki/concepts/prompts-as-contract]] (folded into sdk-surface + prompts-and-workflows)
- `-` [[wiki/concepts/invariants-at-tool-boundary]] (folded into sdk-surface §"Why this design")
- `-` [[wiki/concepts/agent-harness-agnostic]] (folded into harnesses §"Why this design")
- `-` [[wiki/concepts/drop-zone-intake]] (folded into hooks §"Opt-in intake patterns")
- `-` [[wiki/invariants/PROMPTS_ARE_CONTRACT]] (folded into sdk-surface §"Why this design")
- `~` [[wiki/specs/sdk-surface]] — Tool catalog 10→6; added tiered feature model; added "Why this design" with three principles
- `~` [[wiki/specs/hooks]] — folded in extensibility + intake concepts; added 2 shipped default hooks; reframed inbox/ as opt-in
- `~` [[wiki/specs/prompts-and-workflows]] — folded in prompts-as-contract; marked opt-in workflows
- `~` [[wiki/specs/harnesses]] — folded in agent-harness-agnostic
- `~` [[wiki/specs/mcp-surface]] — removed 4 MCP tool entries; marked opt-in workflow prompts
- `~` [[wiki/specs/vault-layout]] — clarified inbox/<bucket>/ is opt-in
- `~` [[wiki/specs/cli]] — dome init drops the --kind profile flag (kept minimal)
- `~` [[wiki/invariants/RAW_IS_IMMUTABLE]] — dropped the appendRawLinkedPage exception (now truly immutable)
- `~` [[wiki/invariants/SENSITIVE_GOES_TO_INBOX]] — reframed as opt-in (tier 3)
- `~` [[wiki/invariants/PAGE_CREATION_REQUIRES_RECURRENCE]] — reframed as opt-in (tier 3)
- `~` [[wiki/invariants/EVERY_WRITE_IS_LOGGED]], [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]], [[wiki/invariants/WIKILINKS_ARE_FULLPATH]] — marked as shipped-default tier
- `~` [[wiki/invariants/RAW_IS_IMMUTABLE]], [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]], [[wiki/invariants/LOG_IS_APPEND_ONLY]], [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] — marked as axiom tier
- `~` [[wiki/matrices/tool-invariant-enforcement]] — rebuilt around 6 Tools × 9 invariants
- `~` [[wiki/matrices/intent-prompt-tools]] — updated tool subsets; marked opt-in workflows
- `~` [[wiki/matrices/event-types-and-payloads]] — noted shipped default hooks
- `~` [[index]] — restructured to reflect tier model and simplified surface
- `~` [[VISION]] — added "Extensibility lives at the hook boundary" as principle #5 (set in prior write)

## [2026-05-25] update | Durability model + git as a hard requirement

Third architectural pass after substrate landed. User pushed back on log-md-as-event-source and asked for a state-based durability model; then locked git as a hard requirement (not just recommended). Six concrete changes landed:

**1. State-based reconciliation, not event-log replay.** The vault's filesystem state + git history are canonical; reconciliation diffs current state vs. a checkpoint. No log.md parsing for execution state. log.md remains audit-only.

**2. `VAULT_IS_GIT_REPO` becomes an axiom.** Every Dome vault is a git repository. `dome init` runs `git init` + initial commit. `openVault` refuses non-git directories. Joins RAW / MARKDOWN / LOG / HOOKS as the fifth axiom (5 axioms total).

**3. `INBOX_IS_EPHEMERAL` becomes a default-tier invariant.** Intake hooks MUST move/delete inbox files on completion. The filesystem signal is what makes reconciliation trivial (file present = pending; file absent = processed). Shipped intake workflows promote inbox files to `raw/<source-type>/`.

**4. `dome reconcile` replaces the earlier `dome process-inbox` proposal.** Broader scope: in-flight recovery (lockfiles in `.dome/in-flight/`), inbox processing, git-diff catchup, scheduled-event catchup. Runs in 4 phases. `dome serve` auto-runs it at startup. CLI: 6 → 7 commands.

**5. `isomorphic-git` is the only git engine.** Pure-JS implementation; zero binary dependency; works in Bun directly. Replaces our earlier consideration of a custom hash-cache (no fallback path needed because git is required).

**6. Inbox/raw becomes default-on.** `dome init` creates `inbox/raw/` AND ships `intake-raw.yaml` as a shipped-default hook. Quick-capture works out of the box. Other intake buckets (voice, research, clip, review) remain opt-in.

**Per-file changes:**

- `+` [[wiki/invariants/VAULT_IS_GIT_REPO]] — new axiom-tier invariant
- `+` [[wiki/invariants/INBOX_IS_EPHEMERAL]] — new shipped-default invariant
- `+` [[wiki/gotchas/hook-non-idempotent]] — what happens when a hook isn't idempotent and reconciliation re-fires
- `+` [[wiki/gotchas/dirty-git-state-at-reconcile]] — reconcile refuses to run during mid-merge / mid-rebase
- `+` [[wiki/entities/git]] — what Dome uses git for
- `+` [[wiki/entities/isomorphic-git]] — the pure-JS git library Dome depends on
- `+` [[wiki/sources/isomorphic-git-library]] — the library's project page
- `~` [[wiki/specs/hooks]] — added §"Durability and reconciliation" + clarified auto-cross-reference exact-match semantics
- `~` [[wiki/specs/cli]] — added `dome reconcile`; `dome init` runs `git init` and creates `inbox/raw/`; 5 → 7 commands
- `~` [[wiki/specs/vault-layout]] — git repo structure, `.dome/{in-flight,state,cache}/` documented, `inbox/raw/` default-on, `external` category for unknown subdirs
- `~` [[wiki/specs/sdk-surface]] — added `isomorphic-git` to dependency list, documented derived operational state under `.dome/`
- `~` [[wiki/specs/prompts-and-workflows]] — deduplicated "Why this design" section (points to sdk-surface as canonical)
- `~` [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — explicit "derived zone" note about `.dome/{in-flight,state,cache}/`
- `~` [[index]] — added 4 new docs (2 invariants, 2 gotchas, 2 entities, 1 source); restructured invariants section with tier markers


