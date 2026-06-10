---
type: spec
created: 2026-06-10
updated: 2026-06-10
sources:
  - "[[daily]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[wiki/specs/vault-layout]]"
---

# Sources subscriptions

This spec is normative for the `dome.sources` bundle — the machinery that turns external source fetches (calendar today; Slack/Granola later) from vault-side launchd timers running scripts *outside* Dome's trust machinery into **subscriptions**: declared in vault config (the consent surface), scheduled by the engine, dispatched as `ExternalActionEffect`s through the outbox (audited, idempotent, retried, revocable), with results landing as ordinary committed `sources/<kind>/<date>.md` files that the daemon adopts.

Nothing downstream changes. The brief already consumes `sources/calendar/<date>.md` as an untrusted committed feed per [[wiki/specs/daily-surface]]; a subscription only changes *who schedules the fetch*, not what the file is. The `sources/` category contract in [[wiki/specs/vault-layout]] §"`sources/`" stays intact: the **engine** never writes the file — the vault-configured fetch command does, as an ordinary non-engine commit the daemon adopts (the capture precedent; [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] is untouched).

## The subscription model

A **subscription** is one external feed the vault has consented to fetch on a schedule. It has five parts, all declared under `extensions.dome.sources.config.subscriptions.<kind>` in `.dome/config.yaml`:

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | Must be **exactly `true`** to run. Absent or `false` → the subscription is silently inert. Consent is explicit, never inferred. |
| `schedule` | string (5-field cron) | When the period's fetch becomes due (e.g. `"10 5 * * *"` — daily at 05:10, before the 05:30 brief). Same grammar as processor `schedule:` triggers (`src/engine/cron.ts`). |
| `kind` | (the map key) | The subscription's identity: `calendar`, `slack`, `granola`, … Lowercase `[a-z0-9._-]`. One subscription per kind by construction (it's a map key). |
| `output_path` | string template | Where the fetched file lands, with a mandatory `{date}` placeholder: `sources/calendar/{date}.md`. Must be a relative vault `.md` path (no `..`, no absolute, no backslash). The `{date}` placeholder is the period key — see §"Periods are local days". |
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

## `dome.sources.fetch` — the scheduled processor

Garden phase, `schedule` trigger `*/15 * * * *`, deterministic execution class, no model. Each tick:

1. **Cheap no-op when nothing is due.** Absent config, empty `subscriptions`, every subscription disabled, nothing due yet, or every due output file already present → returns `[]` (or config diagnostics only). The 15-minute cadence costs a config read and a few snapshot stats.
2. **Per enabled subscription, compute due-ness** from `(schedule, firedAt)` alone: the subscription is due when its cron's **first fire of the current local day** is `<= firedAt`. A cron that hasn't fired yet today, or doesn't fire today at all (weekly schedules), is not due. There is no backfill: a host that was off all day fetches *today's* period when it returns, never yesterday's.
3. **Skip-if-present:** render `output_path` with the period date and read it from `ctx.snapshot` (the adopted state). Present → emit nothing for that subscription. This covers both "a prior fetch already landed" and "the human wrote the file by hand" — a hand-written agenda wins.
4. **Emit one `ExternalActionEffect` per due, absent subscription** with idempotency key `dome.sources:<kind>:<date>` and payload `{ kind, date, output_path, command }`. The payload snapshots exactly what was consented at emit time; the outbox row is the audit record.

**Statelessness, recorded.** The processor keeps no cursor and emits no facts. Due-ness derives from `(cron, firedAt)`, fetch-once derives from the outbox `idempotency_key` UNIQUE constraint, and done-ness derives from snapshot file presence. A last-fetch cursor (the schedule-cursor or ledger pattern) would be a second source of truth for state the outbox + snapshot already carry: re-emitting the same `(kind, date)` key on every tick is a designed no-op (`INSERT OR IGNORE`; a `sent` row returns the cached result; a `pending` row gets its backoff-paced retry attempt), and that re-emission *is* the retry pump for a fetch whose commit hasn't been adopted yet.

**Periods are local days.** `{date}` renders the vault-local `YYYY-MM-DD` of the fire. The `(kind, date)` idempotency key means at most one fetch per kind per local day, regardless of how often the subscription's cron matches. Finer-grained periods are deliberately out of v1 scope — the consuming surfaces (the brief) are daily.

**Config temperament** (consolidate's): a malformed `subscriptions` mapping or a malformed entry (non-map entry, bad kind key, unparseable cron, `output_path` missing `{date}` / escaping the vault / not `.md`, empty or non-string-list `command`) degrades to **skipping that entry with one `info` diagnostic** (`dome.sources.invalid-config`), never a thrown run. Disabled or absent subscriptions produce nothing, silently — disabled is a state, not a problem.

## The handler contract (`sources.fetch`)

The bundle ships the generic handler at `external-handlers/sources.fetch.ts` — the first shipped use of the bundle external-handler contribution kind ([[wiki/matrices/extension-bundle-shape]]; the loader binds `external-handlers/<capability>.ts` default exports by filename stem, and `openVaultRuntime` injects the vault root into each bundle handler's input). The handler is **generic over kinds**: everything kind-specific lives in the vault-configured command.

The contract, in order:

1. Validate the payload (`kind`, `date`, `output_path`, non-empty `command`; `output_path` re-checked vault-relative — defense in depth, the row is data).
2. If `<vault>/<output_path>` already exists on disk, return `{ externalId: "<kind>:<date>", recovered: true }` without spawning — the idempotent crash-recovery path (a prior attempt's command succeeded but the engine died before `markSent`).
3. Spawn `[...command, date, output_path]` with `cwd` = vault root, stdio captured. The engine's dispatch `AbortSignal` kills the child (timeout or shutdown).
4. Non-zero exit → throw (stderr excerpt in the message) → ordinary outbox retry semantics.
5. Exit 0 but the output file still absent → throw `"fetch command exited 0 but did not write <output_path>"` — a fetch that silently produced nothing must be visible, not "sent".
6. Return `{ externalId: "<kind>:<date>" }`.

**The command owns the write and the commit.** The handler never touches vault content. The command writes the file and commits it as an ordinary non-engine commit (the same trust shape as a human edit or `dome capture`); the daemon adopts it through the normal Proposal path. A command that writes without committing leaves a dirty file the daemon won't adopt — the fetch tick keeps re-emitting (snapshot says absent) until the row's attempts exhaust, and the failure surfaces in `dome check`.

**Timeout.** A handler attempt is bounded by the outbox dispatch timeout — default 30 s, configurable per vault as `engine.external_handler_timeout_ms` in `.dome/config.yaml`. Direct API fetchers fit the default; a headless-model fetcher (the claude-calendar template below) needs the vault to raise it (e.g. `300000`).

## The shipped calendar template

The SDK ships `assets/source-handlers/claude-calendar.sh` — a fetch-command template, not SDK code (the model-provider-template precedent: shipped executable vault-side data, never imported by `src/`). Rollout copies it into the vault (conventionally `.dome/bin/fetch-calendar.sh`), adjusts the fetch line (headless `claude -p`, `gcalcli`, EventKit — whatever the vault already uses), and names it in the subscription's `command`. The template enforces the command contract: write `sources/calendar/<date>.md` in the [[wiki/specs/vault-layout]] calendar-day shape, commit it, exit non-zero on any failure (so the outbox sees it).

## The Slack stance

Slack (and Granola, and any conversational feed) is **supported but default-off**: a `slack` subscription is just another map entry (`output_path: "sources/slack/{date}.md"`, a vault-assembled fetch command), and the default config ships *no* Slack entry at all. Two reasons, recorded:

1. **Interactive fetching stays in foreground rituals.** "What did I miss in #team-x" is a conversation with context and follow-ups — that belongs to a foreground agent session (the `/morning`-style rituals), not a cron. Subscriptions are for feeds whose value is *being there before you ask* (the agenda at 05:10).
2. **Volume and sensitivity.** A daily Slack digest committed to the vault is a bigger consent decision than a calendar agenda; it must be a deliberate per-vault opt-in with a vault-authored command, never a shipped default.

## What this kills, vault-side

A vault adopting subscriptions deletes its calendar launchd timer (the plist + the out-of-band log it wrote). The script survives — moved to `.dome/bin/`, trimmed to the command contract — but its *scheduling, retry, audit, and revocation* all move inside Dome: `dome inspect outbox` shows every fetch attempt; `dome check` surfaces terminal failures with a recovery question; disabling is a one-line config flip.

## Lockstep

- [[wiki/matrices/extension-bundle-shape]] row `dome.sources` (the first shipped `external-handlers/` cell) — `tests/integration/bundle-matrix-lockstep.test.ts`.
- [[wiki/matrices/built-in-extensions-x-phase]] row `dome.sources` — same lockstep test.
- Shipped-default grants in `src/cli/default-vault-config.ts` (subscriptions present, calendar `enabled: false`) — `tests/integration/default-vault-config.test.ts`.
- The fetch processor joins the **`dome.daily.edition` maintenance loop as an optional contributor** (`src/extensions/maintenance-loops.ts`) rather than owning a tenth loop: in the default experience its sole purpose is feeding the edition's calendar input, the edition loop already names `sources/calendar/*.md` as evidence, and an own loop would answer "did my agenda arrive" in two places (the same argument that folded the close into the edition loop, [[wiki/specs/daily-surface]] §"The 24-hour choreography"). A future non-edition subscription kind that ships *as a default* would be the trigger to revisit.
- Processor/handler behavior: `tests/extensions/dome.sources/*.test.ts` + the `sources-subscription-fetch` harness scenario (subscription due → outbox row → fake command writes+commits → adoption → snapshot-visible; this scenario un-defers the `external` effect/capability rows of the harness coverage matrix).

## Related

- [[wiki/specs/vault-layout]] §"`sources/`" — the committed-feed category and the calendar-day file shape
- [[wiki/specs/daily-surface]] — the 05:10 calendar row in the 24-hour choreography; the meetings-block degradation
- [[wiki/specs/effects]] §"ExternalActionEffect" — the effect shape and outbox routing
- [[wiki/specs/capabilities]] §"external" — the grant tier; bundle handler binding
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — insert-before-call, idempotency, recovery
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — why the command (not the engine) commits the file
- [[wiki/gotchas/outbox-stuck]] — what a terminally-failed fetch looks like and how it recovers
