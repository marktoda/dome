// ----- Templates ------------------------------------------------------------
//
// The default `.gitignore`, `.dome/config.yaml`, `AGENTS.md`, and
// `CLAUDE.md` content shipped into every new vault. These templates live in
// code (not under assets/) so the binary is self-contained and a future
// `bun build`-produced single-file CLI doesn't need to bundle a templates
// directory — a sibling TS module preserves that (it compiles into the same
// single file). The model-provider template is the exception: it is
// executable vault-side data (a full Bun script speaking the model-provider
// stdio protocol) shipped at `<SDK>/assets/model-providers/` and resolved at
// runtime exactly like the `assets/extensions/` bundles — see
// `readModelProviderTemplate` in ./init.ts.
//
// The user-prose delimiter constants (`USER_PROSE_BEGIN` / `USER_PROSE_END`)
// deliberately stay in ./init.ts: the lockstep test
// tests/invariants/agents-md-is-orientation-surface.test.ts greps that file
// for them.

// The default `.gitignore` shipped into every new vault. Ignores
// `.dome/state/` per [[wiki/specs/vault-layout]] §"Derived operational
// state under .dome/state/" and a few common OS-metadata files.
export const DEFAULT_GITIGNORE = `# Dome — derived operational state. Rebuildable from markdown + git.
.dome/state/

# OS metadata
.DS_Store
Thumbs.db
`;

// The core.md template — the always-loaded core memory page, per
// vault-layout.md §"core.md — the core memory page". A commented skeleton:
// the comment explains the propose-only convention and the size budget the
// dome.markdown.core-size lint enforces. First-write-only; init never
// overwrites the user's core memory.
export const CORE_MD_TEMPLATE = `# Core memory

<!--
Always-loaded owner context: Dome's agents (ingest, consolidate, brief)
read this page at the start of every run. Keep it under ~6,000 characters
— Dome warns past that budget; split details into wiki pages and keep
only the always-relevant summary here.

This page is propose-only for Dome: agents read it but never auto-write
it. Edit it yourself, or accept a Dome question that proposes a change.
Two exceptions, each a marker-delimited generated block Dome maintains:
the promoted-preferences block under Standing preferences (written only
when you answer "promote" to a preference-promotion question) and the
active-projects block under Active projects (refreshed nightly from your
open loops). Leave both blocks' markers alone; everything outside them
is yours.
-->

## Who I am

## Active projects

## Standing preferences
`;

// The preferences/signals.md template — the append-only preference-signal
// log, per preferences.md §signal grammar. Like core.md it is owner data:
// first-write-only, no refresh path. The header is a heading + HTML comment
// only — `parsePreferenceSignals` treats any line starting with `- ` as a
// signal candidate, so the grammar example must stay inline prose.
export const SIGNALS_MD_TEMPLATE = `# Preference signals

<!--
Append-only log of explicit owner corrections of agent behavior. One dated
line per signal: \`- YYYY-MM-DD + <topic-slug>:: <rule> (source: [[page]])\`
(\`-\` instead of \`+\` for evidence against a previously-signaled rule;
reuse existing topic slugs). Lines are appended, never edited or reordered.
Dome tallies signals and asks the owner before promoting a recurring rule
into core.md.
-->
`;

// Renders the AGENTS.md orientation surface around the given user-prose
// section. The delimiters embedded in the section are pinned by
// [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] — the canonical
// constants live in ./init.ts (see the module header above).
export function renderAgentsMd(userProseSection: string): string {
  return `# This is a Dome vault.

This directory is a git-backed markdown vault managed by Dome. Claude Code can
work here using normal file, search, shell, and git tools; Dome watches committed
changes and compiles them into adopted vault state.

## Daily loop

1. Talk with the user and edit markdown normally.
2. Keep changes in ordinary vault files, usually under \`wiki/\`.
3. Commit each coherent unit of work with git.
4. At session start, run \`dome status --json\` and read \`serve_status\`. If it
   is \`off\`, use \`dome sync --json\` after commits unless the user starts a
   foreground \`dome serve\` host in another terminal/session.
5. If \`dome serve\` is running, let it adopt commits in the background.
6. If the user wants to wait for Dome, run \`dome sync --json\`.
7. Run \`dome status --json\` at session boundaries or when Dome reports
   attention. Follow its \`next_actions\`.

Good commit shape:

\`\`\`bash
git add .
git commit -m "describe the vault change"
\`\`\`

## Dome commands

Primary compiler commands:

- \`dome serve\` - keep the local compiler host running.
- \`dome sync --json\` - run one compiler tick now; use this when the user wants
  to wait for adoption or the host was off.
- \`dome status --json\` - fast vault pulse. Read \`attention_required\`,
  \`attention\`, and \`next_actions\`.
- \`dome check --json\` - unified read-only explanation for remaining attention:
  engine health, content diagnostics, and open decisions.
- \`dome resolve <id> <value>\` - resolve a Dome-raised decision from
  \`dome check\`.

Optional adopted-state views:

- \`dome log\` - the vault's activity view: git history joined with the run
  ledger, showing what you and Dome changed and when.
- \`dome query <text>\` - search adopted markdown and related extracted facts.
- \`dome export-context <topic>\` - portable source-backed context packet for
  another Claude session or review.
- \`dome run today\` / \`dome run prep\` / \`dome run agenda-with <person-or-topic>\` -
  deterministic daily / planning / meeting-prep views, invoked through the
  \`dome run <name>\` dispatcher (they are view processors, not standalone
  top-level commands).

## Read-first context

For nontrivial vault work, use Dome's adopted-state views before broad manual
file hunting:

- Start with \`dome export-context <topic> --json\` when preparing a handoff,
  review, planning pass, or multi-file edit.
- Use \`dome query <text> --json\` for focused recall or when the context packet
  looks too broad.
- For daily planning, meeting prep, or person/topic follow-up, prefer a
  natural-language \`dome export-context <topic> --json\` or
  \`dome query <text> --json\` request. The daily note should already be
  prepared in markdown by Dome's background loop.

Treat these as read-first surfaces, not mandatory ceremony. If a packet misses
obvious context or returns noisy results, note the miss in the relevant markdown
or tell the user; that feedback is V1 dogfood evidence.

Advanced/debug commands:

- \`dome inspect <subject>\`, \`dome doctor\`, \`dome lint\`, \`dome answer\`,
  \`dome run <name>\`, and \`dome rebuild\` remain available for debugging,
  compatibility, and extension development, but they are not the normal Claude
  Code workflow.
- Useful inspect subjects are \`bundles\`, \`processors\`, \`runs\`, \`patches\`,
  \`facts\`, \`diagnostics\`, \`questions\`, \`outbox\`, \`quarantine\`, and
  \`cost\`.

Do not call Dome after every edit. Dome works at the git commit boundary.

## Reading Dome status

\`dome status --json\` exposes \`serve_status\`, \`attention_required\`, stable
\`attention\` reason codes, and \`next_actions\`. Treat \`next_actions\` as the
canonical branch for compiler attention. In normal use:

- If \`serve_status\` is \`off\`, no foreground host is adopting commits in the
  background. Use \`dome sync --json\` after commits, or ask the user to start
  \`dome serve\` for a foreground compiler host.
- Run \`dome sync --json\` when status says the compiler needs to catch up.
- Run the \`dome check ...\` command in \`next_actions\` when status says
  attention remains after sync.
- Run \`dome resolve <id> <value>\` only after a Dome question is clear and
  source-grounded.
- Commit, ignore, or remove dirty draft files before expecting Dome to adopt
  them.

## Resolving Dome questions

\`dome check --json\` decision rows include \`automation_policy\` plus optional
\`risk\`, \`confidence\`, \`recommended_answer\`, and \`owner_needed_reason\`
fields.

- \`agent-safe\` / \`model-safe\`: a vault-aware agent may resolve the question
  without interrupting the user when the answer is grounded in the listed
  \`sourceRefs\`, current vault context, and one of the allowed options. Treat
  \`recommended_answer\` as a hint, not authority.
- \`owner-needed\` or missing policy: do not guess. Surface the question and the
  owner-needed reason, then keep unrelated vault work moving.
- Always answer through \`dome resolve <id> <value>\`. Do not edit
  \`.dome/state/\` or use \`dome answer\` in the normal workflow.

## Preference signals

When the owner EXPLICITLY expresses a durable preference or corrects agent
behavior in conversation (filing location, naming, formatting, scope), append
one well-formed signal line to \`preferences/signals.md\`:
\`- YYYY-MM-DD + <topic-slug>:: <rule> (source: [[page]])\` (\`-\` for evidence
against a previously-signaled rule; reuse existing topic slugs). Only explicit
statements — never infer preferences from silence. Promotion stays
owner-mediated: Dome tallies signals and asks the owner before promoting a
rule into \`core.md\` — never write \`core.md\` or its promoted-preferences
block yourself.

## Vault conventions

- \`wiki/\` is the main markdown knowledge base. Pages can link with
  \`[[wikilinks]]\`.
- \`notes/\` is optional unstructured scratch for loose notes that don't yet
  belong in a wiki page — not a parallel knowledge base. Prefer \`wiki/\` for
  anything you want recalled.
- \`inbox/raw/\` is the raw capture drop-zone for committed captures when
  \`dome.agent\` is enabled and model-ready. Before using it, run
  \`dome inspect bundles --json\` and check the \`dome.agent\` row reports
  \`status: "enabled"\` and \`model: "ready"\`. Until then, keep management
  notes directly under \`wiki/\` or \`notes/\`.
- \`inbox/processed/\` is where \`dome.agent\` archives captures it has
  ingested and integrated into generated wiki material.
- Context fetched interactively (Slack digests, live calendar) lands as
  \`sources/<kind>/<date>.md\` day-files, committed normally — the engine
  weaves whatever exists into the daily and omits what doesn't.
- \`preferences/signals.md\` is the append-only preference-signal log — see
  "Preference signals" above for when and how to append to it.
- \`.dome/config.yaml\` controls enabled extension bundles and grants.
- \`.dome/state/\` contains derived SQLite state for projections, outbox, and the
  run ledger. Do not edit or commit it.
- \`.dome/extensions/\` is optional vault-local extension code. The shipped
  first-party bundles live with the SDK and do not need to be copied here.

## Writing wiki pages

Follow the conventions Dome's adoption-phase lint checks — getting them right
means clean adoption instead of warning diagnostics.

**Frontmatter & page type.** Every \`wiki/\` page needs \`type:\` — the singular of
its directory:

| Type | Directory | For |
|---|---|---|
| \`entity\` | \`wiki/entities/\` | people, teams, products, projects, orgs |
| \`concept\` | \`wiki/concepts/\` | ideas, themes, durable claims across captures |
| \`source\` | \`wiki/sources/\` | papers, articles, meetings, scans — evidence |
| \`synthesis\` | \`wiki/syntheses/\` | higher-order analysis, plans, positioning |

Also carry \`created:\`/\`updated:\` ISO dates, a one-line \`description:\` (it
compiles the index), and \`sources:\` — a list of \`[[wikilinks]]\` to the evidence
the page rests on. Cite a source in prose with a \`[[wikilink]]\` rather than
restating it; source-backing is the point.

**Claims** are bold-key lines Dome tracks as durable, dated facts:
\`- **Key:** value *(as of YYYY-MM-DD)* ^c…\`. The \`^c…\` anchor is the claim's
stable identity — Dome stamps it; never write or edit it by hand.

**Tasks** are checkbox lines with their own move-stable identity:
\`- [ ] task text ^t…\` (\`[x]\` when done). The \`^t…\` anchor is how Dome reconciles
a task across daily notes — never remove or change it, and leave any
\`([↗](…))\` origin marker in place.

**Generated blocks.** Some sections are machine-regenerated between paired,
Dome-owned HTML-comment markers (named like \`dome.<bundle>\`; you'll see them in
dailies, \`core.md\`, and index files) — edit the source they derive from, not the
block itself, or your change is overwritten on the next sync.

## Load-bearing rules

- Markdown plus git history are the source of truth.
- Every trusted mutation goes through a Proposal and the adoption loop.
- Processors return Effects; the engine is the only applier.
- Every effect is capability-checked before it lands.
- Projection state is rebuildable from adopted markdown.
- Engine commits carry \`Dome-*\` trailers for auditability.

## Keeping owned prose current

Two kinds of content, opposite contracts:

- **Sources & history** — \`raw/\`, \`notes/\`, historical dailies, the
  preference-signal log, git history. Append or preserve; never overwrite.
- **Owned prose** — \`wiki/\` pages you maintain, syntheses, page
  \`description:\` frontmatter, and these instruction files. When an edit makes
  an existing claim false, delete or replace it in the same edit — don't leave
  the stale claim beside the new one. Git history keeps the prior version, so
  you lose nothing by removing it from the live surface.

Supersede a whole page with \`status: superseded\` + a \`superseded_by:\`
forward-link, not a rewrite. Fix sentence-level staleness inline. "Append to be
safe" is not safety when git already has your back — it is rot.

${userProseSection}
`;
}

export const CLAUDE_MD_TEMPLATE = `@AGENTS.md

## Claude Code

Use the Dome vault workflow in AGENTS.md. Edit markdown normally, commit
coherent changes with git, and use Dome commands when the user asks to wait for
adoption, explain compiler attention, resolve a Dome-raised decision, or render
an explicit source-backed vault view. For nontrivial vault work, read a
\`dome export-context <topic> --json\` packet or focused
\`dome query <text> --json\` result before broad manual file hunting.

The normal command path is \`dome status --json\` -> \`next_actions\` ->
\`dome sync --json\`, the suggested \`dome check ...\` command (often
\`dome check --json\`), or \`dome resolve <id> <value>\`. Resolve
\`agent-safe\` / \`model-safe\` questions only when the answer is grounded in
source refs; surface \`owner-needed\` questions instead of guessing.
`;

export const INITIAL_COMMIT_MESSAGE = `dome init: initial scaffold

Includes:
- AGENTS.md (orientation surface for Claude Code and other harnesses)
- CLAUDE.md (Claude Code shim importing AGENTS.md)
- core.md (always-loaded core memory skeleton — propose-only for Dome)
- preferences/signals.md (append-only preference-signal log, commented header)
- .gitignore (ignores .dome/state/)
- .dome/config.yaml (extension activation + engine settings)

The first-party extension bundles (dome.daily, dome.graph, dome.health,
dome.agent, dome.lint, dome.markdown, dome.search) live with the SDK at
<SDK>/assets/extensions/ and
are resolved at runtime — the vault doesn't carry copies.

Generated by \`dome init\` v1.0
`;
