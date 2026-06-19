---
type: spec
tags:
  - design
  - agent
  - api
  - mobile
created: 2026-06-19
status: approved-design
sources:
  - "[[wiki/concepts/client-model]]"
  - "[[cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client]]"
  - "[[docs/superpowers/specs/2026-06-16-pwa-design]]"
description: "Make the hosted agent read+write: rename /ask → /agent (the `converse` capability), add author-gated write tools (create/edit document → git commit, daemon adopts), and introduce a capability vocabulary as the principled API seam."
---

# Write-capable `/agent` — design

## Why

Today the phone surface is read + two narrow writes (capture, resolve). The desktop agent (Claude Code) is fully read/write because it has a **co-located git checkout** — it edits markdown and commits, and the daemon adopts. The goal: give the **hosted agent** (running beside the vault on the always-on host) the same write ability, so the phone's chat/voice becomes read/write like the desktop — without breaking [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] (a commit *is* the write path; the daemon adopts it).

Two product asks resolve into this one capability: a read/write phone agent, and editable to-dos ("mark the roadmap task done" → the agent edits + commits → the brief refreshes).

This also begins making the API **principled**: capabilities as a named vocabulary, with `author` as a gated, privileged one.

## Decisions (settled in brainstorming)

- **Naming:** `/ask` → `/agent`, `/ask/stream` → `/agent/stream` (the `converse` capability). CLI `dome ask-server` → `dome agent`. Internals `Ask*` → `Agent*`. The old `/ask` names are **deleted, not aliased** — pre-release, so no back-compat shim to carry forward.
- **Gating:** a capability vocabulary in code; `author` granted by a **server-level switch** now (`--allow-write` / `DOME_ALLOW_WRITE`), with per-credential token scopes deferred (the seam, not the machinery — `SECOND_USER_GATE`).
- **Write trust:** **auto-commit + report** (mirrors desktop; git history + the run ledger are the recovery path). Confirm-each-write and an in-app undo are **deferred** — v1 stays lean; recovery is git/desktop, exactly as for the desktop agent today.
- **Scope:** this spec is **focused** — capability model + write-capable `/agent` + rename + author gating + client surfacing. The broader cleanup (de-duplicating `/capture`·`/tasks`·`/resolve` shared with `dome http`, converging the two HTTP servers) is a **fast-follow** with its own spec.

## Architecture

### Capability model (`src/agent/capabilities.ts`)
- A `Capability` union: `"read" | "capture" | "resolve" | "converse" | "author"`.
- `grantedCapabilities(opts): ReadonlySet<Capability>` — derived from server config. Default `{read, capture, resolve, converse}`; add `author` iff write is enabled.
- A guard the routes/tools consult (e.g. `has(granted, "author")`). The single bearer token is unchanged; the granted set is server-wide for now. The names are the seam for later per-token scopes.

### The `/agent` loop + write tools (`src/agent/`)
- `/agent` (buffered) and `/agent/stream` (SSE) run the existing tool-calling loop (search_vault, read_document, todays_brief).
- **When `author` is granted**, the loop additionally gets two write tools (and *only* then):
  - `create_document({ path, content })` — create a new vault page at `path` with `content`.
  - `edit_document({ path, old_string, new_string })` — replace an exact, unique `old_string` with `new_string` in an existing page (the Read-then-Edit pattern; small, safe diffs — e.g. `- [ ] X` → `- [x] X`).
- Both tools write into the co-located checkout and commit (see *Write mechanism* below); the running `dome serve` daemon adopts the commit.
- Path safety: writes are confined to the vault and reject `.dome/` (derived/engine state — never hand-edited) and any path escaping `vaultPath`. Otherwise the agent may write any markdown page, exactly as the desktop agent can — no arbitrary allowlist to invent or maintain.
- Both tools require the `author` capability defensively (not just absent-from-toolset).

### Write mechanism + concurrency
- Writes **reuse** `src/git.ts` (stage + commit) and the existing trailer composition in `src/engine-commit` — the `Dome-Agent: <model-id>` trailer fits the same `Dome-*` scheme `dome log`/activity already parses. No hand-rolled commit formatting.
- Concurrency is **not a new subsystem.** The hosted agent commits exactly as the desktop agent (Claude Code) already does beside a running `dome serve` — a pattern already in production. Rely on git's atomic commit plus a bounded retry on `index.lock`; do not build a lock manager. (Revisit only if retries prove flaky at real frequency.)

### Auth / gating
- `dome agent --allow-write` (or `DOME_ALLOW_WRITE=1`) flips `author` into the granted set; default off (read-only-safe). A deployment that shouldn't author (a public/read-only one) simply omits it.
- The `author` grant is what provisions the write tools into the loop AND what the tools check. Bearer-token auth is unchanged.

## Client (`pwa/`)
- Rename: `DomeClient.ask`/`askStream` → `agent`/`agentStream`; the routes they hit.
- Surface the read/write nature **without a new event type**: the existing **`done` event gains `changes: { path, kind: "create" | "edit" }[]`** (the writes made this turn). The transcript renders a subtle "✎ updated `<page>`" line under the assistant turn.
- When `done.changes` is non-empty, the app refetches `/tasks` + `/recents` so the brief reflects the write (same adoption latency as a capture). Read-only turns trigger no refetch.
- Feature 2 (editable to-dos) needs no dedicated UI: it is the agent editing the daily/page on request, then the brief refetch above. A tap-to-complete shortcut stays a later nicety.

## Error handling
- A write tool that fails (path escapes the vault, `edit_document` `old_string` not found or not unique, git commit fails) returns a tool error the agent surfaces in its answer ("I couldn't update X because …") — it does not crash the loop.
- `author` not granted but a write is attempted: the tool isn't provisioned; if somehow called, it returns a capability error.
- The existing streaming abort/timeout semantics are unchanged.

## Testing
- `capabilities.ts`: `grantedCapabilities` with/without write; the `has` guard.
- `create_document` / `edit_document`: write + commit to a temp git vault; rejected without `author`; path-escape rejected; `edit_document` errors on missing/ambiguous `old_string`.
- Agent loop (mock model that calls a write tool): asserts the file written, committed (with the `Dome-Agent` trailer), and `done.changes` populated; and that without `author` the tools are absent.
- Rename: the renamed routes respond; `bin.test` command-surface lockstep updated for `dome agent`.
- Client: `done.changes` handling (render + refetch trigger); rename of client methods.

## Out of scope (deferred)
- Per-credential token scopes / OAuth (the productized multi-tenant model — `SECOND_USER_GATE`).
- De-duplicating the `/capture`·`/tasks`·`/resolve` handlers shared with `dome http`, and converging the two HTTP servers (fast-follow cleanup spec).
- Confirm-each-write UX; an **in-app undo** (`/agent/undo`); tap-to-complete to-do shortcut. (v1 recovery is git history / desktop, exactly like the desktop agent.)
