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

- **Naming:** `/ask` → `/agent`, `/ask/stream` → `/agent/stream` (the `converse` capability). CLI `dome ask-server` → `dome agent`. Internals `Ask*` → `Agent*`.
- **Gating:** a capability vocabulary in code; `author` granted by a **server-level switch** now (`--allow-write` / `DOME_ALLOW_WRITE`), with per-credential token scopes deferred (the seam, not the machinery — `SECOND_USER_GATE`).
- **Write trust:** **auto-commit + report** (mirrors desktop; git history + run ledger are the undo), plus an **"undo last change"** affordance. Confirm-each-write is deferred.
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
- Both tools: write into the co-located checkout (under `vaultPath`), `git add` + `git commit` with a clear message and a `Dome-Agent: <model-id>` trailer (so the run ledger / `dome log` can distinguish agent-authored commits from human edits). The running `dome serve` daemon adopts the commit.
- Path safety: writes are confined to the vault (reject paths escaping `vaultPath`; restrict to the writable subtree, e.g. under `wiki/` and `notes/` — never `.dome/`).
- Both tools require the `author` capability defensively (not just absent-from-toolset).

### Write mechanism + concurrency
- Writes go through `src/git.ts` helpers (stage + commit), reusing existing native-git plumbing.
- The agent and the `dome serve` daemon are **separate processes** committing to the same repo. The plan must serialize: a commit lock (advisory lockfile under `.dome/`) and/or **commit-with-retry on `index.lock`**. Personal-scale frequency makes contention rare, but it is handled explicitly, not assumed away. (Spike if retry proves flaky.)

### Auth / gating
- `dome agent --allow-write` (or `DOME_ALLOW_WRITE=1`) flips `author` into the granted set; default off (read-only-safe). A deployment that shouldn't author (a public/read-only one) simply omits it.
- The `author` grant is what provisions the write tools into the loop AND what the tools check. Bearer-token auth is unchanged.

## Client (`pwa/`)
- Rename: `DomeClient.ask`/`askStream` → `agent`/`agentStream`; the routes they hit.
- Surface the read/write nature: the stream gains a **`change` event** (`{ type: "change", path, kind: "create" | "edit" }`) the agent emits per write; the transcript renders a subtle "✎ updated `<page>`" line under the assistant turn.
- After the stream completes *with any change event*, the app refetches `/tasks` + `/recents` so the brief reflects the write (same adoption latency as a capture — the daemon ingests, then the view updates).
- **"Undo last change":** when the last assistant turn made changes, offer an undo that calls a new `POST /agent/undo` (reverts the agent's last commit). (Minimal: revert the single most-recent `Dome-Agent` commit.)
- Feature 2 (editable to-dos) needs no dedicated UI: it is the agent editing the daily/page on request. A tap-to-complete shortcut stays a later nicety.

## Error handling
- A write tool that fails (path escapes the vault, `edit_document` `old_string` not found or not unique, git commit fails) returns a tool error the agent surfaces in its answer ("I couldn't update X because …") — it does not crash the loop.
- `author` not granted but a write is attempted: the tool isn't provisioned; if somehow called, it returns a capability error.
- The existing streaming abort/timeout semantics are unchanged.

## Testing
- `capabilities.ts`: `grantedCapabilities` with/without write; the `has` guard.
- `create_document` / `edit_document`: write + commit to a temp git vault; rejected without `author`; path-escape rejected; `edit_document` errors on missing/ambiguous `old_string`.
- Agent loop (mock model that calls a write tool): asserts the file written, committed (with the trailer), and a `change` event emitted; and that without `author` the tools are absent.
- `POST /agent/undo`: reverts the last agent commit on a temp vault.
- Rename: the renamed routes respond; `bin.test` command-surface lockstep updated for `dome agent`.
- Client: the `change`-event reducer; rename of client methods.

## Out of scope (deferred)
- Per-credential token scopes / OAuth (the productized multi-tenant model — `SECOND_USER_GATE`).
- De-duplicating the `/capture`·`/tasks`·`/resolve` handlers shared with `dome http`, and converging the two HTTP servers (fast-follow cleanup spec).
- Confirm-each-write UX; tap-to-complete to-do shortcut.
- Multi-commit undo / richer history surfacing (only single last-change undo here).
