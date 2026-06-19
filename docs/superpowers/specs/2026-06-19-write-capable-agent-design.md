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
description: "Make the hosted agent read+write AND unify the HTTP surface: one capability-gated server (dome http) that absorbs the ask-server, rename /ask → /agent, add author-gated write tools (create/edit document → git commit, daemon adopts), one shared handler per capability."
---

# Write-capable agent + unified HTTP surface — design

## Why

Two product asks — a read/**write** phone agent, and editable to-dos — are one capability: give the **hosted agent** write ability (edit markdown, commit; the daemon adopts), exactly as the desktop agent (Claude Code) already works beside a running `dome serve`. No `submitProposal` — a commit *is* the write path, so [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] holds.

We do this **as one cohesive change** with a long-overdue cleanup: the HTTP surface is split across **two servers** (`dome http` and the ask-server) that **triplicate** `/capture`·`/tasks`·`/resolve` (already caused an error-envelope drift) and each open their own `makeVaultMutex` (the "two concurrent VaultRuntimes" hazard). We collapse them into **one capability-gated server** so the new write capability lands in a clean, unified API rather than bolted onto a duplicated one.

## Decisions (settled in brainstorming)

- **Route naming:** `/ask` → `/agent`, `/ask/stream` → `/agent/stream` (the `converse` capability). Old `/ask` names are **deleted, not aliased** (pre-release).
- **One server, one verb:** `dome http` is the single HTTP server; **`/agent` is a route on it.** The `dome ask-server` verb is **retired** (the `dome agent` verb never ships). `dome http` absorbs the ask-server's flags (`--static-dir`, `--transcribe-*`, `--model`, `--token`, plus the new `--allow-write`).
- **Code:** routing unifies in `src/http/server.ts`; **`src/agent/server.ts` is deleted.** `src/agent/` keeps the *brains* (the agent loop + tools + capabilities), imported by the HTTP server for the `/agent` route.
- **Capability model:** a named vocabulary (`read · capture · resolve · converse · author`) gating **every** route; `author` granted by a **server switch** (`--allow-write` / `DOME_ALLOW_WRITE`); per-credential token scopes deferred (the seam — `SECOND_USER_GATE`).
- **Write trust:** **auto-commit + report**; recovery is git history / desktop. Confirm-each-write and an in-app undo are deferred.
- **Sequencing:** Phase 1 = converge (behavior-preserving, suite stays green); Phase 2 = add the write capability.

## Architecture

### Capability model (`src/capabilities.ts`)
A tiny, dependency-free module both `src/http/` and `src/agent/` import (no cycle):
- `type Capability = "read" | "capture" | "resolve" | "converse" | "author"`.
- `grantedCapabilities({ allowWrite }): ReadonlySet<Capability>` — always `{read, capture, resolve, converse}`; adds `author` iff `allowWrite`.
- `has(granted, cap)` guard. Single bearer token unchanged; the granted set is server-wide for now. The *names* are the seam for later per-token scopes.

### The unified HTTP server (`src/http/server.ts`)
One Bun `fetch`, **one `makeVaultMutex`**, exposing the full surface, each route behind its capability:
- **static** (no auth, when `staticDir` set): `GET /` shell, `/assets/*`; `GET /healthz` ping.
- **read:** `GET /query`, `/doc`, `/questions`, `/status`, `/tasks`, `/recents`, `/today` (HTML cockpit).
- **capture:** `POST /capture`.
- **resolve:** `POST /resolve`.
- **converse:** `POST /agent`, `POST /agent/stream`.
- **transcribe:** `POST /transcribe` (part of the voice-capture flow; gated under `capture`).
- The `/agent` routes dynamic-/static-import the agent loop from `src/agent/`. The server stays a **CLI dynamic-import companion** (never in `src/index.ts`'s static graph), so `bundle-deps` stays green even though it now pulls the AI SDK.

### Shared capability handlers (`src/http/handlers/`)
Extract the request-parse → collector-call → envelope-shape glue for `capture`/`tasks`/`resolve` (and the other read routes) into **one handler per capability**, consumed by the unified server. The `src/surface/*` collectors are unchanged; only the duplicated HTTP glue is unified. This is what deletes the triplication.

### Agent loop + write tools (`src/agent/`)
- `agent.ts` (renamed from `ask.ts`): `runAgent` / `runAgentStream`; `AGENT_CHARTER`; `AgentResult`.
- `tools.ts`: the read tools, **plus `create_document` / `edit_document` when `author` is granted** (and only then):
  - `create_document({ path, content })` — new page.
  - `edit_document({ path, old_string, new_string })` — surgical replace (Read-then-Edit; e.g. `- [ ]` → `- [x]`).
- **Write mechanism:** reuse `src/git.ts` (stage + commit) and `src/engine-commit` trailer composition — a `Dome-Agent: <model-id>` trailer fitting the existing `Dome-*` scheme `dome log`/activity parses. Confined to the vault, **rejecting `.dome/`** and path escapes; otherwise any markdown page (desktop parity). The running daemon adopts the commit.
- **Concurrency:** not a new subsystem — commits like the desktop agent already does beside the daemon; git's atomic commit + a bounded retry on `index.lock`.
- The streaming `done` event gains `changes: { path, kind: "create" | "edit" }[]`.

### Auth / gating
`dome http --allow-write` (or `DOME_ALLOW_WRITE=1`) adds `author` to the granted set → provisions the write tools AND is checked by the tools defensively. Default off (read-only-safe). Bearer auth unchanged.

## Client (`pwa/`)
- Rename `DomeClient.ask`/`askStream` → `agent`/`agentStream` and the routes they hit.
- `done.changes` (no new event type): render a subtle "✎ updated `<page>`" line; when non-empty, refetch `/tasks` + `/recents` so the brief reflects the write (same adoption latency as a capture). Read-only turns: no refetch.
- The PWA is now served by `dome http --static-dir pwa/dist` — update the Vite dev proxy targets and the run docs. **Feature 2 (editable to-dos)** falls out: ask the agent, it edits + commits, the brief refetches.

## Migration / deletion (the collapse)
- **Delete `src/agent/server.ts`** (duplicate routing + mutex); its routes move to `src/http/server.ts`.
- `/capture`·`/tasks`·`/resolve`: **one** shared handler each (were in both servers).
- **Retire the `dome ask-server` CLI verb**; fold its flags into `dome http`. Update the `bin.test` command-surface lockstep (remove `ask-server`; `dome http` gains flags).
- Update the `no-direct-mutation-outside-boundaries` fence allow-list: `src/agent/server.ts` goes away; the temp-file write (transcribe) + the `create/edit_document` writes now live in `src/http/` / the handlers — move the allow-list entry accordingly.

## Sequencing (drives the plan; each phase ships green)
- **Phase 1 — converge (behavior-preserving):** add `src/capabilities.ts`; extract shared handlers; merge the ask-server routes into `dome http`; delete `src/agent/server.ts`; rename `/ask`→`/agent` + retire `dome ask-server`; rename internals + client; update fences/lockstep/run-docs. **No new capability** (`author` off). Full suite green — a pure collapse + rename.
- **Phase 2 — write capability:** `author` gating + `create_document`/`edit_document` + the `Dome-Agent` commit + `done.changes` + the client surfacing + brief refetch.

## Error handling
- A write tool that fails (path escapes / rejects `.dome/`, `old_string` missing or non-unique, commit fails) returns a tool error the agent surfaces in prose — it does not crash the loop.
- `author` not granted: the write tools aren't provisioned; a defensive call returns a capability error.
- Existing streaming abort/timeout semantics unchanged.

## Testing
- `capabilities.ts`: granted set with/without `allowWrite`; the guard.
- Unified server: every route responds and is capability-gated; the **moved** routes (`/agent`, `/recents`, `/transcribe`, static) behave exactly as before (no regression); `/capture`·`/tasks`·`/resolve` go through the single shared handler.
- Write tools (Phase 2): write + commit (with the `Dome-Agent` trailer) to a temp git vault; rejected without `author`; path-escape and `.dome/` rejected; `edit_document` errors on missing/ambiguous `old_string`; `done.changes` populated.
- Rename: renamed routes respond; `bin.test` lockstep updated.
- Client: `done.changes` handling (render + refetch); method rename.
- Fences green: `bundle-deps` (server stays a dynamic-import companion), `public-surface-shape`, `no-direct-mutation` (allow-list moved).

## Out of scope (deferred)
- Per-credential token scopes / OAuth (the productized multi-tenant model — `SECOND_USER_GATE`).
- Confirm-each-write UX; an in-app undo (`/agent/undo`); tap-to-complete to-do shortcut. (v1 recovery = git / desktop.)
- Any change to `src/surface/*` collector semantics (this is an API-surface + agent change, not a collector change).
