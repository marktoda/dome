# This is a Dome vault.

This directory is a git-backed markdown vault managed by Dome. Claude Code can
work here using normal file, search, shell, and git tools; Dome watches committed
changes and compiles them into adopted vault state.

## Daily loop

1. Talk with the user and edit markdown normally.
2. Keep changes in ordinary vault files, usually under `wiki/`.
3. Commit each coherent unit of work with git.
4. At session start, run `dome status --json` and read `serve_status`. If it
   is `off`, use `dome sync --json` after commits unless the user starts a
   foreground `dome serve` host in another terminal/session.
5. If `dome serve` is running, let it adopt commits in the background.
6. If the user wants to wait for Dome, run `dome sync --json`.
7. Run `dome status --json` at session boundaries or when Dome reports
   attention. Follow its `next_actions`.

Good commit shape:

```bash
git add .
git commit -m "describe the vault change"
```

## Dome commands

Primary compiler commands:

- `dome serve` - keep the local compiler host running.
- `dome sync --json` - run one compiler tick now; use this when the user wants
  to wait for adoption or the host was off.
- `dome status --json` - fast vault pulse. Read `attention_required`,
  `attention`, and `next_actions`.
- `dome check --json` - unified read-only explanation for remaining attention:
  engine health, content diagnostics, and open decisions.
- `dome resolve <id> <value>` - resolve a Dome-raised decision from
  `dome check`; `dome proposals` lists garden-proposed edits awaiting
  review, decided with `dome apply <id>` or `dome reject <id>`.
- `dome settle <block-id> <close|defer|keep>` - settle a task line by its
  `^block-anchor` in one ordinary commit (`defer` requires
  `--until YYYY-MM-DD`); the direct disposition verb for tasks surfaced by
  the daily note or stale-task questions.

Optional adopted-state views:

- `dome views --json` - discover every command-triggered view contributed by
  the vault's installed plugins.
- `dome log` - the vault's activity view: git history joined with the run
  ledger, showing what you and Dome changed and when.
- `dome query <text>` - search adopted markdown and related extracted facts.
- `dome export-context <topic>` - portable source-backed context packet for
  another Claude session or review.
- `dome explain <path[#^anchor]>` - provenance for a page or one claim:
  claim → facts → ledger evidence → engine commits.
- `dome today --prep [--date <yyyy-mm-dd>]` - deterministic source-backed
  planning packet for a day.
- `dome today --with <person-or-topic>` - deterministic open tasks,
  follow-ups, and context filtered to a person or topic.
- `dome audit stale-claims` - claims whose `*(as of)*` date is older than
  the staleness horizon (default 120 days).
- `dome audit orphan-pages` - markdown pages with no incoming wikilinks.

## Source-first reading

Markdown is the source of truth and native file tools are the fastest path
when the scope is known. Use the smallest read surface that answers the need:

- For a known page, entity, directory, or bounded edit, read and search the
  markdown directly.
- Run `dome views --json` to discover the compiled views installed by this
  vault's plugins; do not assume every vault has `today`, `query`, or any other
  named view.
- Use `dome query <text> --json` for unknown or cross-vault recall, and
  `dome export-context <topic> --json` when a source-backed multi-page packet
  materially helps a handoff, review, or planning pass.
- Open the returned markdown sources before important claims or edits. Views
  summarize adopted state; they do not replace the evidence they cite.

If a packet misses obvious context or returns noisy results, report it with
`dome query "<text>" --miss "what was missing"` (or the same `--miss` flag on
`dome export-context`) instead of just telling the user — the retrieval-miss
log is the evidence better retrieval (embeddings) is gated on.

Advanced/debug commands:

- `dome inspect <subject>`, `dome doctor`, `dome lint`, `dome answer`,
  `dome run <name>`, and `dome rebuild` remain available for debugging,
  compatibility, and extension development, but they are not the normal Claude
  Code workflow.
- Useful inspect subjects are `bundles`, `processors`, `runs`, `patches`,
  `facts`, `diagnostics`, `questions`, `outbox`, `quarantine`, and
  `cost`.

Do not call Dome after every edit. Dome works at the git commit boundary.

## Reading Dome status

`dome status --json` exposes `serve_status`, `attention_required`, stable
`attention` reason codes, and `next_actions`. Treat `next_actions` as the
canonical branch for compiler attention. In normal use:

- If `serve_status` is `off`, no foreground host is adopting commits in the
  background. Use `dome sync --json` after commits, or ask the user to start
  `dome serve` for a foreground compiler host.
- Run `dome sync --json` when status says the compiler needs to catch up.
- Run the `dome check ...` command in `next_actions` when status says
  attention remains after sync.
- Run `dome resolve <id> <value>` only after a Dome question is clear and
  source-grounded.
- Commit, ignore, or remove dirty draft files before expecting Dome to adopt
  them.

## Resolving Dome questions

`dome check --json` decision rows include `automation_policy` plus optional
`risk`, `confidence`, `recommended_answer`, and `owner_needed_reason`
fields.

- `agent-safe`: run `dome agent-work --json`, read every required evidence
  path directly, then complete the packet with its revision, allowed answer,
  reason, and repeated `--evidence <path>` flags. `model-safe` is a legacy
  spelling with the same meaning. Recommendations are hints, not authority.
- `owner-needed` or missing policy: do not guess. Surface the question and the
  owner-needed reason, then keep unrelated vault work moving.
- Complete autonomous agent decisions through `dome agent-work`; use `dome
  resolve` for owner-directed decisions. Never edit `.dome/state/`.

## Preference signals

When the owner EXPLICITLY expresses a durable preference or corrects agent
behavior in conversation (filing location, naming, formatting, scope), append
one well-formed signal line to `preferences/signals.md`:
`- YYYY-MM-DD + <topic-slug>:: <rule> (source: [[page]])` (`-` for evidence
against a previously-signaled rule; reuse existing topic slugs). Only explicit
statements — never infer preferences from silence. Promotion stays
owner-mediated: Dome tallies signals and asks the owner before promoting a
rule into `core.md` — never write `core.md` or its promoted-preferences
block yourself.

## Vault conventions

- `wiki/` is the main markdown knowledge base. Pages can link with
  `[[wikilinks]]`.
- `notes/` is optional unstructured scratch for loose notes that don't yet
  belong in a wiki page — not a parallel knowledge base. Prefer `wiki/` for
  anything you want recalled.
- `inbox/raw/` is the raw capture drop-zone for committed captures when
  `dome.agent` is enabled and model-ready. Before using it, run
  `dome inspect bundles --json` and check the `dome.agent` row reports
  `status: "enabled"` and `model: "ready"`. Until then, keep management
  notes directly under `wiki/` or `notes/`.
- `inbox/processed/` is where `dome.agent` archives captures it has
  ingested and integrated into generated wiki material.
- Context fetched interactively (Slack digests, live calendar) lands as
  `sources/<kind>/<date>.md` day-files, committed normally — the engine
  weaves whatever exists into the daily and omits what doesn't.
- `preferences/signals.md` is the append-only preference-signal log — see
  "Preference signals" above for when and how to append to it.
- `.dome/config.yaml` controls enabled extension bundles and grants.
- `.dome/state/` contains derived SQLite state for projections, outbox, and the
  run ledger. Do not edit or commit it.
- `.dome/extensions/` is optional vault-local extension code. The shipped
  first-party bundles live with the SDK and do not need to be copied here.

## Writing wiki pages

Follow the conventions Dome's adoption-phase lint checks — getting them right
means clean adoption instead of warning diagnostics.

**Frontmatter & page type.** Every `wiki/` page needs `type:` — the singular of
its directory:

| Type | Directory | For |
|---|---|---|
| `entity` | `wiki/entities/` | people, teams, products, projects, orgs |
| `concept` | `wiki/concepts/` | ideas, themes, durable claims across captures |
| `source` | `wiki/sources/` | papers, articles, meetings, scans — evidence |
| `synthesis` | `wiki/syntheses/` | higher-order analysis, plans, positioning |

Also carry `created:`/`updated:` ISO dates, a one-line `description:` (it
compiles the index), and `sources:` — a list of `[[wikilinks]]` to the evidence
the page rests on. Cite a source in prose with a `[[wikilink]]` rather than
restating it; source-backing is the point.

**Claims** are bold-key lines Dome tracks as durable, dated facts:
`- **Key:** value *(as of YYYY-MM-DD)* ^c…`. The `^c…` anchor is the claim's
stable identity — Dome stamps it; never write or edit it by hand.

**Tasks** are checkbox lines with their own move-stable identity:
`- [ ] task text ^t…` (`[x]` when done). The `^t…` anchor is how Dome reconciles
a task across daily notes — never remove or change it, and leave any
`([↗](…))` origin marker in place.

**Generated blocks.** Some sections are machine-regenerated between paired,
Dome-owned HTML-comment markers (named like `dome.<bundle>`; you'll see them in
dailies, `core.md`, and index files) — edit the source they derive from, not the
block itself, or your change is overwritten on the next sync.

## Load-bearing rules

- Markdown plus git history are the source of truth.
- Every trusted mutation goes through a Proposal and the adoption loop.
- Processors return Effects; the engine is the only applier.
- Every effect is capability-checked before it lands.
- Projection state is rebuildable from adopted markdown.
- Engine commits carry `Dome-*` trailers for auditability.

## Keeping owned prose current

Two kinds of content, opposite contracts:

- **Sources & history** — `raw/`, `notes/`, historical dailies, the
  preference-signal log, git history. Append or preserve; never overwrite.
- **Owned prose** — `wiki/` pages you maintain, syntheses, page
  `description:` frontmatter, and these instruction files. When an edit makes
  an existing claim false, delete or replace it in the same edit — don't leave
  the stale claim beside the new one. Git history keeps the prior version, so
  you lose nothing by removing it from the live surface.

Supersede a whole page with `status: superseded` + a `superseded_by:`
forward-link, not a rewrite. Fix sentence-level staleness inline. "Append to be
safe" is not safety when git already has your back — it is rot.

<!-- BEGIN user-prose -->

## Your own notes about this vault

(Anything you add between the BEGIN / END user-prose delimiters above
and below survives Dome's templated-section regeneration. The templated
sections above the delimiter are regenerated by
`dome init --refresh-instructions`.)

<!-- END user-prose -->
