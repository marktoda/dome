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
failure so the outbox sees it. Fetch line: `icalBuddy` scoped to `$1`'s day,
formatted to the normative `- HH:MM–HH:MM — Title (attendees: …)` lines the
shipped parser reads. No new CLI flag — the spec's "adjust the fetch line"
contract already covers template choice; the recipe names this template as
the deterministic macOS default.

**Pruning (same subsystem, from the live-ops audit):** `dome.sources.fetch`
currently runs 4×/hour as a ledger-visible no-op when every subscription is
disabled (~1,400 runs/14d). Change: when no subscription is enabled, the
tick must not produce full no-op run rows — the planner picks the seam from
what exists (the run ledger's `skipped` state, quarantine's precedent, or a
scheduler-level gate), preferring the cheapest one that keeps the ledger
honest. Unit test: all-disabled → zero succeeded-with-no-effect rows.

**Work-vault rollout (owner step first):** Mark adds the Uniswap Google
account to macOS Calendar (System Settings → Internet Accounts). Then: swap
`.dome/bin/fetch-calendar.sh`'s FETCH section for the icalBuddy template,
flip `subscriptions.calendar.enabled: true`, restart the daemon, and **probe
TCC**: the launchd context needs Calendar permission once; verification =
one daemon-driven fetch producing a committed `sources/calendar/<date>.md`
(outbox row `sent`, agenda block rendered). The TCC failure mode and its
fix (grant Calendar access to the daemon's binary context, re-run) are
documented in the recipe, not left to be rediscovered.

## Part B — `/morning` personal skill (rung 4, NOT product)

A skill in the owner's `~/.claude` setup: fetch the overnight Slack digest
via the session's Slack tools → write `sources/slack/<date>.md` in the
slack-day shape → pathspec commit → optionally `dome sync` and read back the
enriched daily. Ships nothing in the SDK. Recorded here so the boundary is
legible, not because the product owns it.

## Part C — one interface sentence (product-side)

The vault AGENTS.md template gains a single conventions sentence: context
fetched interactively (Slack digests, live calendar) lands as
`sources/<kind>/<date>.md` day-files, committed normally — the engine weaves
whatever exists and omits what doesn't. Teaches the interface; no routine.

## Part D — docs + backlog

- [[wiki/specs/sources]] recipe: name `icalbuddy-calendar.sh` as the
  deterministic macOS path; keep `claude-calendar.sh` as the foreground
  reference.
- Backlog (explicit): the durable Slack fix is a deterministic Slack Web API
  fetcher with a file-stored token — the change that deletes even the
  `/morning` skill.

## Testing

No new engine behavior except the sources.fetch no-poll change (unit-tested).
The template follows whatever test posture `claude-calendar.sh` has (shipped
vault-side data); if untested there, untested here — consistency over
ceremony. Acceptance is operational: one real morning where
`sources/calendar/<date>.md` lands by ~05:15 via the daemon and the agenda
block renders with no foreground session.
