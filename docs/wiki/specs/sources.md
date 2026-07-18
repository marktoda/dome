---
type: spec
created: 2026-06-10
updated: 2026-07-11
sources:
  - "[[daily]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[wiki/specs/vault-layout]]"
description: "dome.sources subscriptions: consent in config, engine-scheduled fetches via the outbox; the fetch command, not the engine, writes sources/ files"
---

# Sources subscriptions

This spec is normative for the `dome.sources` bundle — the machinery that turns external source fetches (calendar today; Slack/Granola later) from vault-side launchd timers running scripts *outside* Dome's trust machinery into **subscriptions**: declared in vault config (the consent surface), scheduled by the engine, dispatched as `ExternalActionEffect`s through the outbox (audited, idempotent, retried, revocable), with results landing as ordinary committed `sources/<kind>/<date>.md` files that the daemon adopts.

Nothing downstream changes. The brief already consumes `sources/calendar/<date>.md` as an untrusted committed feed per [[wiki/specs/daily-surface]]; a subscription only changes *who schedules the fetch*, not what the file is. The `sources/` category contract in [[wiki/specs/vault-layout]] §"`sources/`" stays intact: the **engine** never writes the file — the vault-configured fetch command does, as an ordinary non-engine commit the daemon adopts (the capture precedent; [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] is untouched).

## The subscription model

A **subscription** is one external feed the vault has consented to fetch on a schedule. It has five parts, all declared under `extensions.dome.sources.config.subscriptions.<kind>` in `.dome/config.yaml`:

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | Must be **exactly `true`** to run. Absent or `false` → the subscription is silently inert. Consent is explicit, never inferred. |
| `schedule` | string (5-field cron) | When the period's fetch becomes due (e.g. `"10 5 * * *"` — daily at 05:10, before the 05:30 brief). Same grammar as processor `schedule:` triggers (`src/engine/operational/cron.ts`). |
| `kind` | (the map key) | The subscription's identity: `calendar`, `slack`, `granola`, … Lowercase `[a-z0-9._-]`. One subscription per kind by construction (it's a map key). |
| `output_path` | string template | Where the fetched file lands, with a mandatory `{date}` placeholder: `sources/calendar/{date}.md`. Must be a relative vault `.md` path **under `sources/`** (no `..`, no absolute, no backslash) — subscriptions are committed feeds, and the `sources/` prefix keeps the fetch command from becoming a general vault write channel. The `{date}` placeholder is the period key — see §"Periods are local days". Two subscriptions whose templates render to the same path collide (the second would permanently skip-if-present behind the first); the duplicate is skipped with a config problem diagnostic. |
| `command` | string list | The fetch command (argv shape, like `model_provider.command`). Run by the handler from the **vault root**, with the date and output path appended as the final two arguments. The command does the fetching, the writing, and the committing. |

The config block is the **consent surface**: granting `external: ["sources.fetch"]` to `dome.sources` plus flipping a subscription to `enabled: true` is the complete opt-in. Removing either revokes it — no launchd plist to hunt down.

```yaml
extensions:
  dome.sources:
    enabled: true
    config:
      subscriptions:
        calendar:
          enabled: false          # vaults opt in explicitly
          schedule: "10 5 * * *"
          output_path: "sources/calendar/{date}.md"
          command: ["sh", ".dome/bin/fetch-calendar.sh"]
    grant:
      read:
        - "sources/**/*.md"
        - ".dome/config.yaml"
      external:
        - "sources.fetch"
```

## The flow

```
.dome/config.yaml                       (consent: subscription declared + enabled)
        │
        ▼  every 15 min while `dome serve` runs
dome.sources.fetch (garden, cron */15)  reads config + adopted snapshot
        │   due this period?  output file absent?
        ▼  yes → ExternalActionEffect { capability: "sources.fetch",
        │                               idempotencyKey: "dome.sources:<kind>:<date>",
        │                               payload: { kind, date, output_path, command } }
        ▼
capability broker                       external:"sources.fetch" grant checked
        ▼
outbox.db                               row inserted BEFORE any call
        ▼                               (EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX)
sources.fetch handler                   spawns `<command...> <date> <output_path>`
        │                               cwd = vault root
        ▼
fetch command                           fetches, writes sources/<kind>/<date>.md,
        │                               commits it (ordinary NON-engine commit)
        ▼
daemon adopts the commit                file becomes adopted vault state
        ▼
next fetch tick                         sees the file in the snapshot → emits nothing
```

Failure at the handler follows ordinary outbox retry semantics (bounded exponential backoff, `maxAttempts` 3 default); terminal failure is visible in `dome check` / `dome inspect outbox` and recoverable through the `dome.health` outbox-recovery questions, exactly like every other external action. Nothing about the outbox state machine is special-cased.

One failure class is caught **before any fetch ever runs**: `dome doctor` raises a `sources.fetch-script-missing` **warning** when an enabled subscription's command references a script file that is missing or not a regular file — the stanza-enabled-but-script-missing gap, which would otherwise fail every scheduled fetch and only surface as decoded outbox rows the next morning. The probe is static by design (doctor never executes a fetch command — it would hit Slack or the calendar for real): the script reference is derived from the command shape alone — `command[0]` when it carries a path separator, else `command[1]` for the standard `["sh", ".dome/bin/fetch-<kind>.sh"]` interpreter shape, skipping flag arguments. Commands with no checkable reference (bare PATH lookups, `sh -c` inline scripts) are silently unprobed — a false positive on a working command would be worse than silence, and their failures still surface through the outbox findings. Recovery requires an explicit reviewed script/config edit; dedicated source setup is planned for M9.

## `dome.sources.fetch` — the scheduled processor

Garden phase, `schedule` trigger `*/15 * * * *`, deterministic execution class, no model. Each tick:

1. **Cheap no-op when nothing is due.** Absent config, empty `subscriptions`, every subscription disabled, nothing due yet, or every due output file already present → returns `[]` (or config diagnostics only). The 15-minute cadence costs a config read and a few snapshot stats.
2. **Per enabled subscription, compute due-ness** from `(schedule, firedAt)` alone: the subscription is due when its cron's **first fire of the current local day** is `<= firedAt`. A cron that hasn't fired yet today, or doesn't fire today at all (weekly schedules), is not due. There is no backfill: a host that was off all day fetches *today's* period when it returns, never yesterday's.
3. **Skip-if-present:** render `output_path` with the period date and read it from `ctx.snapshot` (the adopted state). Present → emit nothing for that subscription. This covers both "a prior fetch already landed" and "the human wrote the file by hand" — a hand-written agenda wins.
4. **Emit one `ExternalActionEffect` per due, absent subscription** with idempotency key `dome.sources:<kind>:<date>` and payload `{ kind, date, output_path, command }`. The payload snapshots exactly what was consented at emit time; the outbox row is the audit record.

**Statelessness, recorded.** The processor keeps no cursor and emits no facts. Due-ness derives from `(cron, firedAt)`, fetch-once derives from the outbox `idempotency_key` UNIQUE constraint, and done-ness derives from snapshot file presence. A last-fetch cursor (the schedule-cursor or ledger pattern) would be a second source of truth for state the outbox + snapshot already carry: re-emitting the same `(kind, date)` key on every tick is a designed no-op (`INSERT OR IGNORE`; a `sent` row returns the cached result; a `pending` row gets its backoff-paced retry attempt), and that re-emission *is* the retry pump for a fetch whose commit hasn't been adopted yet.

**Periods are local days.** `{date}` renders the vault-local `YYYY-MM-DD` of the fire. The `(kind, date)` idempotency key means at most one fetch per kind per local day, regardless of how often the subscription's cron matches. Finer-grained periods are deliberately out of v1 scope — the consuming surfaces (the brief) are daily.

**The end-of-day dead window (documented limitation).** Due-ness is only *observed* at the 15-minute fetch ticks, and a new local day resets it: a schedule whose first fire of the day lands strictly after the day's final fetch tick — between 23:45 and midnight on the `*/15` grid — is never seen due (by the next tick it is already a new day, whose first fire hasn't happened yet). This is accepted, not fixed: backfilling across midnight would contradict the no-backfill rule, and subscriptions exist to be there *before* the morning surfaces — schedule them at 23:45 or earlier (in practice: in the morning). The same mechanism is why a host asleep over midnight fetches today's period on wake, never yesterday's.

**Config temperament** (consolidate's): a malformed `subscriptions` mapping or a malformed entry (non-map entry, bad kind key, unparseable cron, `output_path` missing `{date}` / escaping the vault / not `.md` / outside `sources/` / rendering to the same path as an earlier subscription, empty or non-string-list `command`) degrades to **skipping that entry with one `info` diagnostic** (`dome.sources.invalid-config`), never a thrown run. Disabled or absent subscriptions produce nothing, silently — disabled is a state, not a problem.

## The handler contract (`sources.fetch`)

The bundle ships the generic handler at `external-handlers/sources.fetch.ts` — the first shipped use of the bundle external-handler contribution kind ([[wiki/matrices/extension-bundle-shape]]; the loader binds `external-handlers/<capability>.ts` default exports by filename stem, and `openVaultRuntime` injects the vault root into each bundle handler's input). The handler is **generic over kinds**: everything kind-specific lives in the vault-configured command.

The contract, in order:

1. Validate the payload (`kind`, `date`, `output_path`, non-empty `command`; `output_path` re-checked vault-relative, `.md`, and under `sources/` — defense in depth, the row is data; symmetric with the processor's template validation).
2. **Re-check consent against the live config** (§"Consent is re-checked at dispatch"): re-derive the subscription from `extensions.dome.sources.config.subscriptions` by `kind`; a missing/disabled subscription, a changed `command`, or a changed rendered `output_path` → throw with a clear refusal.
3. If `<output_path>` already exists **in the vault's HEAD commit** (isomorphic-git blob read — never the working tree), return `{ externalId: "<kind>:<date>", recovered: true }` without spawning — the idempotent crash-recovery path (a prior attempt's command wrote *and committed* but the engine died before `markSent`). A file that exists only in the working tree is an *incomplete* fetch (written, not committed) and deliberately does not recover — it falls through to the spawn, whose commit-only retry completes it (see below).
4. Spawn `[...command, date, output_path]` with `cwd` = vault root, **in its own process group** (`detached: true`), `stdout` ignored (a fetcher that chats >64 KB to stdout must never deadlock the never-drained pipe — diagnostics belong on stderr), `stderr` captured for error excerpts. On the engine's dispatch `AbortSignal` (timeout or shutdown) the handler SIGTERMs the **process group** via the negative pid — so a `sh → claude` grandchild tree dies with its parent — and escalates to SIGKILL after a 500 ms grace (the `command-model-provider` probe's escalation, mirrored).
5. Non-zero exit → throw (stderr excerpt in the message) → ordinary outbox retry semantics.
6. Exit 0 but the output file still absent **from HEAD** → throw. Two distinguishable messages: written-to-the-worktree-but-uncommitted ("did not commit it — the retry will commit the existing file") versus not written at all ("exited 0 but did not write <output_path>") — a fetch that silently produced nothing, or produced a file the daemon will never adopt, must be visible, not "sent".
7. Return `{ externalId: "<kind>:<date>" }`.

## Consent is re-checked at dispatch

The outbox row's payload snapshots what was consented **at emit time**; the handler trusts none of it. At dispatch time it re-derives the subscription from the *current* `.dome/config.yaml` by `kind` and requires the payload's `command` and rendered `output_path` to match exactly; the `dome.sources` extension and the subscription must still be enabled. Any mismatch refuses the row (throw → retry → terminal failure, visible in `dome check`).

Two properties fall out:

1. **Revocation is immediate.** Flipping `enabled: false` (or deleting the subscription, or disabling the extension) kills already-queued rows at their next dispatch attempt — there is no window where a revoked fetch still runs because its row predates the flip.
2. **The grant is not an arbitrary-exec channel.** `external: ["sources.fetch"]` only ever executes commands that the live config declares; a forged or stale outbox row whose command differs from the config is refused, so writing a row is never enough to run something.

The refusal is loud by design (a failed row, not a silent skip): a row that stops matching config is either deliberate revocation (the human can abandon the row from `dome check`) or config drift worth seeing.

**The command owns the write and the commit.** The handler never touches vault content. The command writes the file and commits it as an ordinary non-engine commit (the same trust shape as a human edit or `dome capture`); the daemon adopts it through the normal Proposal path. The handler verifies completion **against HEAD**: a command that writes without committing (hook failure, killed mid-script) fails the attempt with a "did not commit" error and the row retries — and the command contract makes that retry cheap: *when the output file already exists, skip the fetch and just commit it* (the shipped template's commit-only path). Commits are **pathspec-scoped** (`git commit -m ... -- "$f"`) so a human's concurrently staged work is never swept into a fetch commit, and **signing-immune** in the shipped templates: `land()` commits with `git -c commit.gpgsign=false`, so a vault inheriting global `commit.gpgsign=true` cannot fail the non-interactive fetch commit on a missing key or absent gpg agent (vault-data commits are engine-class — unsigned, like the engine's own isomorphic-git commits; `dome doctor` raises an info `git.commit-signing` finding when the effective vault config signs, naming the immune vs affected paths). A `git index.lock` collision with a concurrent writer (the daemon's closure commit, a human mid-commit) simply exits the command non-zero — a transient failure the ordinary backoff retry absorbs; it cannot stall the engine, which never waits on the vault's git lock.

**Timeout.** A handler attempt is bounded by the outbox dispatch timeout — default 30 s, configurable per vault as `engine.external_handler_timeout_ms` in `.dome/config.yaml`. Direct API fetchers fit the default; a headless-model fetcher (the claude-calendar template below) needs the vault to raise it (e.g. `300000`). `dome doctor` surfaces the footgun as an **info** finding (`config.sources-timeout-default`) whenever any subscription is enabled while the key is unset — the simplest honest trigger (sniffing the command string for a model-runner pattern would miss wrappers and false-positive on names), and info severity because a direct fetcher under the default is healthy.

## The shipped calendar templates

The SDK ships TWO calendar fetch-command templates — vault-side data, not SDK code (the model-provider-template precedent: shipped executable vault-side data, never imported by `src/`). `assets/source-handlers/claude-calendar.sh` drives headless `claude -p` against the owner's claude.ai Google Calendar connector; it is a foreground-only reference (§"Connector-backed fetch is foreground-only"), not something to enable unmodified on a daemon. `assets/source-handlers/icalbuddy-calendar.sh` is **the deterministic macOS default for daemon subscriptions**: it reads Calendar.app directly via `icalBuddy` (EventKit), so it needs no interactive login session and a launchd-spawned daemon can run it unattended (icalBuddy is macOS/EventKit-only — no systemd equivalent applies here); it handles recurring events correctly, takes an optional `ICAL_CALENDARS` include-list env var to exclude noise calendars (empty means all — edit the default in your copied `.dome/bin/fetch-calendar.sh`, the daemon-safe home for this setting, since a shell `export` never reaches the daemon), and still writes and commits an empty day's file rather than skipping it. A macOS TCC Calendar-access denial makes `icalBuddy` exit non-zero, which the template propagates — failing loud through the ordinary outbox retry → health-question path, no new signal needed.

An owner may explicitly copy a shipped template to `.dome/bin/fetch-calendar.sh`, add the disabled subscription stanza, review it, and then enable it; dedicated source setup is planned for M9. A genuinely daemon-driven fetch should use `icalbuddy-calendar.sh` (or `gcalcli`, EventKit, or a direct API call—whatever the vault can reach without an interactive session). Both templates enforce the same command contract: write `sources/calendar/<date>.md` in the [[wiki/specs/vault-layout]] calendar-day shape, commit it with a pathspec-scoped commit, exit non-zero on any failure (so the outbox sees it)—and when the output file already exists, skip the fetch entirely and just commit it (the commit-only retry for a prior attempt whose commit failed).

## Connector-backed fetch is foreground-only

**Normative finding (verified, recorded 2026-06-14).** The shipped `claude-calendar.sh` and `claude-slack.sh` templates default their FETCH block to headless `claude -p` driving the owner's **claude.ai connectors** (Google Calendar, Slack) — the WS5 bet that reusing the owner's existing connectors would avoid provisioning a per-source API token. **That bet does not hold for the daemon.** claude.ai connectors are bound to the interactive OAuth-subscription login session; they do **not** load in a `claude -p` spawned non-interactively by the daemon (launchd/systemd), which returns empty output or "not logged in". The illusion that it worked came from testing in an interactive terminal — a full login session — where the connectors are present. A daemon-spawned fetch is a different process with no such session.

Consequences, normative:

1. **The shipped connector templates are foreground / example references, not working daemon fetchers.** They demonstrate the command contract (write the day-file shape, REPAIR/VALIDATE/LAND, pathspec-scoped signing-immune commit) and run correctly when invoked by hand inside an interactive `claude` session; they are not what an enabled subscription should run unmodified on a daemon.
2. **Automated daemon fetch requires a DETERMINISTIC source** — one that needs no interactive login. For calendar, the shipped `assets/source-handlers/icalbuddy-calendar.sh` template (§"The shipped calendar templates") is the ready-made option: copy it in and flip `enabled: true`, no hand-written fetcher required. For Slack, or a calendar source other than Calendar.app, the fallback shape is a direct Calendar or Slack Web API call with a **file-stored token**. Anything that emits the day-file markdown shape on stdout without depending on a connector session works. The subscription machinery (consent re-check, outbox, retry, HEAD-verified completion, revocation) is unchanged — only the FETCH line must be swapped for a deterministic fetcher before a subscription is genuinely daemon-driven.
3. **Calendar has a deterministic daemon path now; Slack does not, yet.** The shipped `icalbuddy-calendar.sh` template lets a vault run calendar as a genuine daemon subscription with no foreground session — copy it in, set `ICAL_CALENDARS`, flip `enabled: true`. Slack has no equivalent shipped deterministic fetcher: live Slack still comes from the owner's morning foreground Claude session, where the connector is loaded (the `/morning`-style ritual), until a deterministic Slack Web API fetcher ships (backlog). The daemon-composed brief covers **vault state** — yesterday digest, open loops, questions — and gracefully omits the meetings and Slack surfaces when no day-file is present ([[wiki/specs/daily-surface]] §"The degradation ladder"; an absent source file means "not known", never a fabricated section).

## The Slack stance

Slack (and Granola, and any conversational feed) is **supported but default-off**: a `slack` subscription is just another map entry (`output_path: "sources/slack/{date}.md"`, schedule `"15 5 * * *"` — after the calendar, before the brief), and the default config ships *no* Slack entry at all. Two reasons, recorded:

1. **Interactive fetching stays in foreground rituals.** "What did I miss in #team-x" is a conversation with context and follow-ups — that belongs to a foreground agent session (the `/morning`-style rituals), not a cron. Subscriptions are for feeds whose value is *being there before you ask* (the agenda at 05:10).
2. **Volume and sensitivity.** A daily Slack digest committed to the vault is a bigger consent decision than a calendar agenda; it must be a deliberate per-vault opt-in with a **vault-adopted** fetch command — a shipped template (`assets/source-handlers/claude-slack.sh`) the owner reviews and enables — never a shipped-on default.

What ships is the template, never consent or automatic scaffolding. An owner may explicitly copy it to `.dome/bin/fetch-slack.sh`, add a subscription stanza with `enabled: false`, review both, and then enable it; dedicated source setup is planned for M9. The template's default fetch is headless `claude -p` against the owner's claude.ai Slack connector—reading Slack **as the owner**—prompting for an overnight digest in the slack-day shape normative at [[wiki/specs/vault-layout]] §"`sources/slack/YYYY-MM-DD.md`". **But that connector-backed fetch is foreground-only** (§"Connector-backed fetch is foreground-only"): the claude.ai connector loads in an interactive session, not in the daemon's non-interactive `claude -p`, so a daemon-driven Slack subscription must use a deterministic source such as the Slack Web API. The **consent surface is the script plus the flip**; revocation is the same one-line flip as any subscription. The template validates before committing so refusal/error/empty output fails through ordinary outbox retry. Downstream, `dome.agent.brief` parses the committed digest defensively and injects it as data, never instructions ([[wiki/specs/autonomous-agents]] §"`dome.agent.brief`").

## What is deliberately NOT a subscription: the capture-queue drain

The iCloud capture-queue drain ([[wiki/specs/capture]] §"The iCloud queue
fallback") looks subscription-shaped — a periodic external job feeding the
vault — and is deliberately not one. The subscription contract above is
structural, not stylistic: **one output file per period**, with due-ness
derived from `(cron, firedAt)`, done-ness from that file's snapshot presence
(skip-if-present), and completion HEAD-verified against that exact path after
the command exits. The drain violates every clause: it produces many files
per run (zero on most runs), reads a queue directory *outside* the vault, and
has no single `output_path` to skip on or verify against. So it ships as a
recipe-installed launchd interval job (`dome recipe capture-queue` —
[[wiki/specs/cli]] §"`dome recipe`"), the same manual-unit precedent as the
`dome-http` service unit, with `dome capture --capture-id` as its idempotency
seam instead of the outbox key. Wedging it in here would mean loosening
`output_path` into a directory contract and skip-if-present into a per-file
scan — don't. The next many-files-per-period feed should reach for the
external-job precedent, not this spec.

## What this kills, vault-side

A vault adopting subscriptions deletes its calendar launchd timer (the plist + the out-of-band log it wrote). The script survives — moved to `.dome/bin/`, trimmed to the command contract — but its *scheduling, retry, audit, and revocation* all move inside Dome: `dome inspect outbox` shows every fetch attempt; `dome check` surfaces terminal failures with a recovery question; disabling is a one-line config flip.

## Lockstep

- [[wiki/matrices/extension-bundle-shape]] row `dome.sources` (the first shipped `external-handlers/` cell) — `tests/integration/bundle-matrix-lockstep.test.ts`.
- [[wiki/matrices/built-in-extensions-x-phase]] row `dome.sources` — same lockstep test.
- Shipped-default grants in `src/cli/default-vault-config.ts` (subscriptions present, calendar `enabled: false`) — `tests/integration/default-vault-config.test.ts`.
- The fetch processor joins the **`dome.daily.edition` maintenance loop as an optional contributor** (`src/extensions/maintenance-loops.ts`) rather than owning a tenth loop: in the default experience its sole purpose is feeding the edition's calendar input, the edition loop already names `sources/calendar/*.md` as evidence, and an own loop would answer "did my agenda arrive" in two places (the same argument that folded the close into the edition loop, [[wiki/specs/daily-surface]] §"The 24-hour choreography"). A future non-edition subscription kind that ships *as a default* would be the trigger to revisit.
- Processor/handler behavior: `tests/extensions/dome.sources/*.test.ts` + the `sources-subscription-fetch` harness scenario (subscription due → outbox row → fake command writes+commits → adoption → snapshot-visible; this scenario un-defers the `external` effect/capability rows of the harness coverage matrix).

## Related

- [[wiki/specs/vault-layout]] §"`sources/`" — the committed-feed category and the calendar-day / slack-day file shapes
- [[wiki/specs/daily-surface]] — the 05:10 calendar and opt-in 05:15 slack rows in the 24-hour choreography; the meetings-block degradation
- [[wiki/specs/effects]] §"ExternalActionEffect" — the effect shape and outbox routing
- [[wiki/specs/capabilities]] §"external" — the grant tier; bundle handler binding
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — insert-before-call, idempotency, recovery
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — why the command (not the engine) commits the file
- [[wiki/gotchas/outbox-stuck]] — what a terminally-failed fetch looks like and how it recovers
- [[wiki/specs/capture]] §"The iCloud queue fallback" — the many-files external job that deliberately stays outside this contract
