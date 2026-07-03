---
type: brainstorm
tags:
  - design
  - sources
  - intake
  - daily
created: 2026-07-02
updated: 2026-07-02
status: design-approved
sources:
  - "[[cohesive/brainstorms/2026-07-01-product-review-round-2-compiled-daily]]"
  - "[[cohesive/brainstorms/2026-07-01-compiled-blocks-daily-design]]"
  - "[[wiki/specs/sources]]"
  - "[[wiki/specs/vault-layout]]"
  - "[[philosophy]]"
---

# Intake close — deterministic calendar + the ownership ladder applied

Approved design, 2026-07-02. Closes the intake half of Gate 1
([[cohesive/brainstorms/2026-07-01-product-review-round-2-compiled-daily]]):
the daemon fetches the calendar deterministically so the compiled daily's
agenda block lights up before any terminal opens; Slack stays a foreground
fetch, deliberately client-side.

## The boundary decision that shaped this

The original proposal shipped a `/morning` ritual contract in the vault
AGENTS.md template. Pressure-testing it produced the **ownership ladder**
([[philosophy]] §"The ownership ladder"): the engine owns state contracts and
their observability; agents own behavior; the contract specifies interfaces,
not itineraries. The ritual decomposed into: daemon calendar (rung 2) + slack
day-file shape (rung 1, already normative) + missing-source loudness (rung 3,
already shipped) + one interactive Slack fetch (rung 4, client-side). What
remains product-side is small and interface-shaped.

## Part A — daemon calendar via icalBuddy (rung 2)

**SDK:** new fetch-command template `assets/source-handlers/icalbuddy-calendar.sh`
beside `claude-calendar.sh`, honoring the identical handler contract
([[wiki/specs/sources]]): invoked from vault root as `<command> <date>
<output_path>`; writes the calendar-day shape ([[wiki/specs/vault-layout]]
§"sources/"); pathspec-scoped commit; when the output file already exists,
skip the fetch and commit-only (the retry contract); exit non-zero on any
failure so the outbox sees it. No new CLI flag — the spec's "adjust the
fetch line" contract already covers template choice; the recipe names this
template as the deterministic macOS default.

**Template contract, pinned to the shipped parser** (`parseMeetingLine` in
`dome.daily/processors/calendar-day.ts` — verified against the source):

- `$1` is the **fire-date's local day** (`localDateOf(firedAt)`,
  `dome.sources/processors/fetch.ts:275`) — the subscription fetches TODAY's
  agenda for today's brief; icalBuddy is bounded to exactly that day
  (`eventsFrom:"$1 00:00:00" to:"$1 23:59:59"`).
- Line shape `- HH:MM–HH:MM — Title (attendees: a, b)`: time via
  `-tf '%H:%M'` (the parser takes `\d{1,2}:\d{2}` with en-dash/em-dash/hyphen
  ranges); attendees suffix optional (parser tolerates absence); **all-day
  events render as title-only bullets** (parser yields `time: null`).
- **An empty day still writes and commits the file** — zero meeting lines
  under the normative header. Absent file means "agenda unknown"; a present
  empty file means "known: no meetings" and flips the sources line to
  `calendar ✓`. The distinction is the point.
- An `ICAL_CALENDARS` variable (optional include-list → `-ic`) keeps
  Birthdays/US Holidays noise out; empty means all calendars. Time/locale
  pinned (`LC_ALL=C`, explicit `-tf`/`-df`) so output is deterministic.
- **TCC loudness rides existing machinery:** on Calendar-access denial
  icalBuddy errors → the template exits non-zero → outbox retry →
  `failed` → the health recovery question. No new signal needed; the
  recipe documents the grant path (System Settings → Privacy & Security →
  Calendars, after the first attempt registers the daemon context).

**Pruning — descoped to the pruning pass (plan-time finding):** the
15-minute no-op polling (~1,400 rows/14d) cannot be silenced without new
engine vocabulary — even quarantine's `skipped` path writes ledger rows,
and a scheduler-level config gate built for one consumer is the
generalize-at-N=1 trap ([[philosophy]]): the health trio's per-minute crons
(~60k rows/14d) need the identical gate. One scheduler-gate design at N≥3
belongs to the pruning pass; this project ships none of it.

**Work-vault rollout (owner step gates acceptance):** Mark adds the Uniswap
Google account to macOS Calendar (System Settings → Internet Accounts;
verified NOT yet present at design time — `icalbuddy calendars` shows zero
CalDAV entries). Then: swap `.dome/bin/fetch-calendar.sh`'s FETCH section
for the icalBuddy template, flip `subscriptions.calendar.enabled: true`,
restart the daemon, and probe: one daemon-driven fetch (next 15-minute tick
or `launchctl kickstart`) producing a committed `sources/calendar/<date>.md`
— outbox row `sent`, agenda block rendered. On TCC denial the failure is
already loud (outbox → health question); grant Calendar access and let the
retry clear it.

## Part B — `/morning` personal skill (rung 4, NOT product)

A skill in the owner's `~/.claude` setup (created during execution, as a
client-side artifact — never SDK-shipped): fetch the overnight Slack digest
via the session's Slack tools → write `sources/slack/<date>.md` in the
slack-day shape (validated header: `---`/`date:`/`# Slack <date>`) →
pathspec commit → optionally `dome sync` and read back the enriched daily.
Recorded here so the boundary is legible, not because the product owns it.

## Part C — one interface sentence (product-side)

The vault AGENTS.md template (`src/cli/commands/init-templates.ts`) gains a
single conventions sentence: context fetched interactively (Slack digests,
live calendar) lands as `sources/<kind>/<date>.md` day-files, committed
normally — the engine weaves whatever exists and omits what doesn't.
Teaches the interface; no routine. Existing vaults pick it up via
`dome init --refresh-instructions` (templated sections regenerate; user
prose survives) — the work-vault rollout includes that refresh.

## Part D — docs + backlog

- [[wiki/specs/sources]] recipe: name `icalbuddy-calendar.sh` as the
  deterministic macOS path; keep `claude-calendar.sh` as the foreground
  reference.
- Backlog (explicit): the durable Slack fix is a deterministic Slack Web API
  fetcher with a file-stored token — the change that deletes even the
  `/morning` skill.

## Testing

No new engine behavior at all (the no-poll change descoped, §Part A). The
template follows whatever test posture `claude-calendar.sh` has (shipped
vault-side data); if untested there, untested here — consistency over
ceremony. Acceptance is operational: one real morning where
`sources/calendar/<date>.md` lands by ~05:15 via the daemon and the agenda
block renders with no foreground session.
