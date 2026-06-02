# This is a Dome vault.

This directory is a git-backed markdown vault managed by Dome. Claude Code can
work here using normal file, search, shell, and git tools; Dome watches committed
changes and compiles them into adopted vault state.

## Daily loop

1. Talk with the user and edit markdown normally.
2. Keep changes in ordinary vault files, usually under `wiki/`.
3. Commit each coherent unit of work with git.
4. If `dome serve` is running, let it adopt the commit in the background.
5. If the user wants to wait for Dome, run `dome sync --json`.
6. Run `dome status --json` at session boundaries or when Dome reports
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
  `dome check`.

Optional adopted-state views:

- `dome query <text>` - search adopted markdown and related extracted facts.
- `dome export-context <topic>` - portable source-backed context packet for
  another Claude session or review.
- `dome today`, `dome prep`, and `dome agenda <person-or-topic>` -
  deterministic daily/planning views when explicitly useful.

## Read-first context

For nontrivial vault work, use Dome's adopted-state views before broad manual
file hunting:

- Start with `dome export-context <topic> --json` when preparing a handoff,
  review, planning pass, or multi-file edit.
- Use `dome query <text> --json` for focused recall or when the context packet
  looks too broad.
- Use `dome today --json`, `dome prep --json`, or
  `dome agenda <person-or-topic> --json` when the task is daily planning,
  meeting prep, or person/topic follow-up.

Treat these as read-first surfaces, not mandatory ceremony. If a packet misses
obvious context or returns noisy results, note the miss in the relevant markdown
or tell the user; that feedback is V1 dogfood evidence.

Advanced/debug commands:

- `dome inspect <subject>`, `dome doctor`, `dome lint`, `dome answer`,
  `dome run`, and `dome rebuild` remain available for debugging,
  compatibility, and extension development, but they are not the normal Claude
  Code workflow.
- Useful inspect subjects are `bundles`, `processors`, `runs`, `patches`,
  `facts`, `diagnostics`, `questions`, `outbox`, and `quarantine`.

Do not call Dome after every edit. Dome works at the git commit boundary.

## Reading Dome status

`dome status --json` exposes `attention_required`, stable `attention`
reason codes, and `next_actions`. Treat `next_actions` as the canonical
branch. In normal use:

- Run `dome sync --json` when status says the compiler needs to catch up.
- Run the `dome check ...` command in `next_actions` when status says
  attention remains after sync.
- Run `dome resolve <id> <value>` only after a Dome question is clear and
  source-grounded.
- Commit, ignore, or remove dirty draft files before expecting Dome to adopt
  them.

## Resolving Dome questions

`dome check --json` decision rows include `automation_policy` plus optional
`risk`, `confidence`, `recommended_answer`, and `owner_needed_reason` fields.

- `agent-safe` / `model-safe`: a vault-aware agent may resolve the question
  without interrupting the user when the answer is grounded in the listed
  `sourceRefs`, current vault context, and one of the allowed options. Treat
  `recommended_answer` as a hint, not authority.
- `owner-needed` or missing policy: do not guess. Surface the question and the
  owner-needed reason, then keep unrelated vault work moving.
- Always answer through `dome resolve <id> <value>`. Do not edit
  `.dome/state/` or use `dome answer` in the normal workflow.

## Vault conventions

- `wiki/` is the main markdown knowledge base. Pages can link with
  `[[wikilinks]]`.
- `.dome/config.yaml` controls enabled extension bundles and grants.
- `.dome/state/` contains derived SQLite state for projections, outbox, and the
  run ledger. Do not edit or commit it.
- `.dome/extensions/` is optional vault-local extension code. The shipped
  first-party bundles live with the SDK and do not need to be copied here.

## Load-bearing rules

- Markdown plus git history are the source of truth.
- Every trusted mutation goes through a Proposal and the adoption loop.
- Processors return Effects; the engine is the only applier.
- Every effect is capability-checked before it lands.
- Projection state is rebuildable from adopted markdown.
- Engine commits carry `Dome-*` trailers for auditability.

<!-- BEGIN user-prose -->

## Your own notes about this vault

(Anything you add between the BEGIN / END user-prose delimiters above
and below survives Dome's templated-section regeneration. The templated
sections above the delimiter are regenerated by
`dome init --refresh-instructions`.)

<!-- END user-prose -->
