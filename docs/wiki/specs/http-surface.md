---
type: spec
created: 2026-06-10
updated: 2026-07-11
sources:
  - "[[wiki/specs/capture]]"
  - "[[wiki/specs/sdk-surface]]"
  - "[[wiki/specs/task-lifecycle]]"
description: "dome http converged adapter: bearer-token data routes, session-oriented AgentRuntime conversation, capture, deterministic plugin views, decisions, transcription, and the PWA."
---

# HTTP surface

> **Product posture:** this document specifies the shipped prototype/compatibility
> Adapter. The PWA-first product target is [[wiki/specs/product-host]]. P1/P2
> product journeys are loopback-only; remote/Tailscale exposure remains
> disabled until P3 replaces the shared bearer with paired, scoped device
> credentials, exact-origin/CSRF enforcement, bounded sessions, and truthful
> readiness. `dome http` remains useful during that migration but is not the
> final product lifecycle.

This spec is normative for `dome http` — the HTTP read+capture+converse
protocol adapter (`src/http/server.ts`, hosted by the `dome http` verb). It is
the same surface class as the MCP adapter ([[wiki/specs/mcp-surface]]), lifted
onto HTTP for callers that can't mount stdio: phones, iOS Shortcuts,
scripts on other machines. It is also the first shipped form of the
remote-capture seam ([[wiki/specs/capture]] §"The remote-capture seam").

```text
src/http/server.ts — createDomeHttpServer({ vaultPath, bundlesRoot?, token }) → { fetch }
  ↓
dome http [--port 3663] [--host 127.0.0.1] [--token …]
         [--model …] [--static-dir …] [--allow-write]
         [--transcribe-cmd …] [--transcribe-key …] [--transcribe-url …] [--transcribe-model …]
         [--agent-log <path>]
         (Bun.serve; one vault per process)
```

The adapter is deliberately thin and consumes the same data paths as the
MCP tools — the public `openVault` wrapper plus the protocol-neutral
`src/surface/` collectors ([[wiki/linters/surface-adapters-dont-import-adapters]]).
No parallel query or serialization logic; results are the same JSON
documents the CLI emits under `--json`.

## Capabilities

The server gates every route on a named capability. The vocabulary is:
`read · capture · resolve · converse · author`. All five are granted by default
**except `author`**, which must be explicitly enabled with `dome http
--allow-write` (or the environment variable `DOME_ALLOW_WRITE=1` /
`DOME_ALLOW_WRITE=true`).

`author` gates the agent's write tools (`create_document` /
`edit_document`). A write lands as an ordinary git commit carrying a
`Dome-Agent` trailer — the same mechanism as `dome capture` — and the running
daemon adopts it on its next tick. Default-off keeps the server read-only-safe:
a phone on Tailscale can open an agent session for Q&A without being able to write
the vault. The same granted set also drives which contract tools the Dome
assistant is provisioned with (§"The assistant's tools").

Per-device scoped credentials, pairing, revoke/rotation, and browser cookie
auth are planned in [[wiki/specs/product-host]]. Until that contract lands,
the single bearer is acceptable only for loopback/private owner-operated
prototype use and is not a public product security posture.

`--agent-log <path>` (or `DOME_AGENT_LOG=<path>`) enables a structured
per-turn log for `POST /sessions/:id/messages`: one JSON line per
request recording the granted capabilities, `authorEnabled`, `changes`,
`stopReason`, a 500-char `answerPreview`, `durationMs`, and any `error`. When
unconfigured the sink is a no-op with zero cost. Write errors are caught and
logged to stderr — they never propagate into the request path.

## Routes

Every route requires `Authorization: Bearer <token>` (constant-time
comparison; 401 otherwise) — with two scoped exceptions: `GET /today` accepts
the token as `?token=` (below), and the two `GET /today/fonts/*.woff2` static
asset routes are served fully **unauthenticated** (§"Cacheable font assets").
One vault per process.

| Route | Same path as | Result schema |
|---|---|---|
| `GET /` | — | `dome.http/v1` identity document; includes `capabilities: string[]` — the sorted list of granted capabilities (e.g. `["capture","converse","read","resolve"]`; `"author"` only when `--allow-write` is set) |
| `POST /capture` `{text, title?, captureId?}` | `performCapture` with `source: "http"` | `dome.capture/v1` (`status: captured \| duplicate`) |
| `GET /status` | `dome status --json` | status snapshot (stable keys) |
| `GET /attention` | `vault.attention()` | `dome.attention/v1` canonical owner queue |
| `GET /agent-work?limit=…&questionId=…` | `vault.agentWork()` | `dome.agent-work/v1` derived queue |
| `POST /agent-work/complete` `{questionId, expectedRevision, answer, reason, evidence}` | `vault.completeAgentWork()` | `dome.agent-work-completion/v1` |
| `POST /agent-work/drain` `{limit?}` | `drainAgentWork` through built-in or injected `AgentWorkAgent` | `dome.agent-work-drain/v1` |
| `GET /query?text=…` | `dome query --json` | `dome.search.query/v1` |
| `GET /views` | `vault.listViews()` | `dome.views/v1` |
| `POST /views/:command` JSON input | `runInstalledView` → `vault.runView(command)` | `dome.view-run/v1` |
| `GET /tasks?date=…` | `dome run today` | `dome.daily.today/v1` |
| `GET /today?refresh=…` | the `dome.daily.today` view → `renderTodayHtml` | `text/html` cockpit page (`cache-control: no-store`) |
| `GET /today/fonts/basel-book.woff2` | static Basel asset (cacheable) | `font/woff2` (immutable; **unauthenticated**) |
| `GET /today/fonts/basel-medium.woff2` | static Basel asset (cacheable) | `font/woff2` (immutable; **unauthenticated**) |
| `GET /doc?path=…` | `vault.readDocument` (adopted ref) | `dome.http.document/v1` |
| `GET /questions` | `vault.listQuestions` (open only) | `dome.http.questions/v1` |
| `POST /resolve` `{id, value}` | `dome resolve` | `dome.answer/v1` |
| `POST /settle` `{blockId, disposition, deferUntil?}` | `performSettle` (`resolve` capability — settling is a decision, same trust domain as resolve) | `dome.settle/v1` (`status: settled \| not-found \| invalid`) |
| `GET /proposals?all=1` | `collectProposals` (`read` capability; defaults to pending rows only) | `dome.proposals/v1` |
| `POST /apply` `{id}` | `performApply` (`resolve` capability — the settle pattern for garden-proposed edits) | `dome.apply/v1` (`status: applied \| stale \| not-found \| not-pending \| invalid`) |
| `POST /reject` `{id, note?}` | `performReject` (`resolve` capability) | `dome.reject/v1` (`status: rejected \| not-found \| not-pending \| invalid`) |
| `POST /sessions` | create an in-memory foreground-agent session (`converse` capability) | `dome.agent-session/v1` |
| `POST /sessions/:id/messages` `{message}` | multi-turn `AgentRuntime` turn | SSE `text \| done \| error` events |
| `DELETE /sessions/:id` | close an agent session | `dome.agent-session/v1` |
| `POST /transcribe` audio body | STT step: shell command or OpenAI-compatible cloud endpoint (`capture` capability; 501 when unconfigured) | `dome.transcribe/v1` `{text}` |
| `GET /recents` | recent vault changes (`read` capability) | `dome.recents/v1` `{count, entries}` |

The session routes are backed by **AgentRuntime** (`src/assistant/runtime.ts`).
The shipped adapter uses the co-located AI SDK loop in `src/assistant/`; a
different runtime can replace it without changing HTTP, the PWA, plugins, or
the engine. This foreground runtime is distinct from the `dome.agent`
background processor bundle that runs inside the garden phase.

### The assistant's tools

The assistant speaks the same contract as the routes: beyond its two
always-on read tools, its action tools are thin wrappers over the shared
`src/surface/` collectors, provisioned per tool from the **same granted
capability set the routes gate on** (the server passes the set into
`runAgentStream`; `buildAgentTools` in `src/assistant/tools.ts`
applies the table below). Same collectors, same capability vocabulary — an
operation the bearer could not reach as a route is not reachable through the
assistant either.

| Tool | Capability | Same path as | Result schema |
|---|---|---|---|
| `run_view` | — (always on) | `runInstalledView` for any installed plugin view | `dome.view-run/v1` |
| `read_document` | — (always on) | `vault.readDocument` | page markdown |
| `capture_note` | `capture` | `performCapture` with `source: "assistant"` | `dome.capture/v1` |
| `settle_task` | `resolve` | `performSettle` | `dome.settle/v1` |
| `resolve_question` | `resolve` | `vault.resolve` | `dome.answer/v1` |
| `list_agent_work` | `read` | `vault.agentWork` | `dome.agent-work/v1` |
| `complete_agent_work` | `resolve` | `vault.completeAgentWork` using citations actually gathered this turn | `dome.agent-work-completion/v1` |
| `list_proposals` | `read` | `collectProposals` | `dome.proposals/v1` |
| `apply_proposal` | `resolve` | `performApply` | `dome.apply/v1` |
| `reject_proposal` | `resolve` | `performReject` | `dome.reject/v1` |
| `create_document` | `author` | agent write path (`src/assistant/write.ts`) | change confirmation |
| `edit_document` | `author` | agent write path (`src/assistant/write.ts`) | change confirmation |

Mutating tools append one entry to the run's `changes` array — the same array
the SSE `done` event and the agent log carry —
so a settled task or an applied proposal surfaces in the PWA's change display
exactly like an author write. Under the default grant (everything but
`author`) the assistant can capture, settle, resolve, and review proposals,
but cannot author pages; these are decisions and captures, not authoring
([[wiki/concepts/client-model]] §"The authoring boundary").

Tests: `tests/assistant/tools.test.ts` (§"contract-tool provisioning" pins the
capability gates; §"contract tools (invocation)" exercises the collectors
against real vault fixtures).

Errors are JSON envelopes (`{status: "error", error, message}`) with honest
HTTP codes: 400 usage, 401 auth, 404 missing, 409 unworkable git state or a
proposal-decision conflict (`POST /apply`/`POST /reject` on a proposal that
is already decided, or `POST /apply` on one that has gone stale),
413 oversized body, 503 adopted-ref churn, 500 the rest.

## The cockpit page (`GET /today`)

The one non-JSON route: it runs the same `dome.daily.today` view as
`GET /tasks`, then renders the structured result through `renderTodayHtml`
(`src/http/today-html.ts`, a pure data→HTML function with no engine imports)
into a phone-friendly dark-mode page — open tasks, follow-ups, and questions
with their `dome resolve` hints, or "All clear" when nothing is open. This is
the glanceable cockpit surface of the v1 plan; `dome today --watch` is its
terminal sibling.

Freshness is **JS polling by design** (the v1 plan's "dumb polling is
acceptable" resolution): the page ships a self-contained inline `<script>`
that polls `GET /tasks` on an interval, diffs the fingerprint against the
last result, and calls `location.reload()` when content changes. The script
reads `?token=` from `location.search` at runtime so the parameter survives
reloads without any server-side per-reload round-trip. There is no `<meta
http-equiv="refresh">`. `?refresh=<seconds>` sets the poll cadence (JS
`POLL_MS = refreshSeconds * 1000`) — a positive integer, default 15 when
absent or unparseable; the renderer floors it at 1.

The poll **fingerprint projects only user-visible fields** — the task/question
ids, titles, and urgency the page actually renders — never the volatile
projection metadata (`attention`, `lastChangedAt`, and the like) that churns on
every compiler tick without changing what the page shows. A naive whole-payload
fingerprint reloaded the page on every background adoption; narrowing it to the
visible projection means the page reloads only when the rendered content
actually changes.

Once the page loads, the inline script **scrubs `?token=` from the URL** via
`history.replaceState` (the token is kept in the JS closure for the polls'
`Authorization` header). The bearer survives in memory for the session; it no
longer sits in the visible address bar or in any link copied off the loaded
page.

The HTML response is sent with `cache-control: no-store`: an authenticated page
whose URL can carry `?token=`, and whose freshness contract is the JS poll
interval — it must never be cached. (The font assets below are the deliberate
exception — non-sensitive static bytes that *should* cache hard.)

### Cacheable font assets (`GET /today/fonts/*.woff2`)

The cockpit's CSS references the Basel typeface via two static routes —
`GET /today/fonts/basel-book.woff2` and `GET /today/fonts/basel-medium.woff2`.
They are served:

- with `content-type: font/woff2`;
- with `cache-control: public, max-age=31536000, immutable` — the fonts are
  content-stable, so the browser fetches each once and never revalidates;
- **unauthenticated** — these two GET routes (and only these) skip the bearer
  check. A browser's CSS `url()` font fetch carries no `Authorization` header
  and no cookies, so requiring a token would simply break font loading; the
  bytes are non-sensitive public static assets, not vault data. Every other
  route — including the `GET /today` HTML itself — keeps its bearer/query-token
  auth.

Pulling the fonts out of the HTML (they were previously inlined as base64)
drops the `/today` page to ~25 KB and lets the browser cache the heavy font
bytes across reloads instead of re-parsing them inside every poll-triggered
page load.

**Briefing panels.** The cockpit page includes three additive panels sourced
from graph facts emitted by the `dome.agent` adoption extractors:

- **Brief** — driven by `dome.agent.brief` facts (predicate `dome.agent.brief`);
  `dome.agent.brief-index` extracts the `dome.agent.brief:today` block from each
  adopted daily note and emits one fact carrying the stripped plain-text body +
  a sourceRef. The panel is omitted when no fact exists for today.
- **Calendar** — driven by `dome.agent.calendar.event` facts (predicate
  `dome.agent.calendar.event`); `dome.agent.calendar-index` extracts events from
  `sources/calendar/<date>.md` files and emits one fact per event. The panel is
  omitted when no events exist for today.
- **Hero** — the single highest-priority open task or question, derived from
  the same `dome.daily.today/v1` view data as the rest of the page; no
  separate fact.

**Mutations via the query token.** The cockpit's inline script uses the `?token=`
bearer to authorize mutations (`POST /capture` and `POST /resolve`) in addition
to the read polls. This is an accepted trust boundary: the shared bearer already
authorizes the page fetch; reusing it for mutations inside the same loopback/
trusted-LAN session is the intended v1 contract (§"Trust domain").

### Query-token escape hatch (`GET /today`)

`GET /today` — and **only** `GET /today` — additionally accepts the bearer
token as `?token=<token>`, because browser navigations cannot carry an
`Authorization` header and the cockpit's whole point is "open it from the
phone's home screen". The query token goes through the same SHA-256 digest
and constant-time comparison as the header path; the scoping is method- and
path-exact, so `POST /today?token=…` and every other route stay header-only.

The trade is named honestly: the token appears in the URL (browser history,
possibly proxy logs). That is acceptable inside the loopback/Tailscale
owner-trust domain this surface is restricted to (§"Trust domain") — and it
is exactly why this escape hatch **never widens** to other routes: every
programmatic caller can set a header, so no other route has the
browser-navigation excuse.

Tests: `tests/http/http-server.test.ts` (§"GET /today" — header and query
auth, GET-only scoping, JS poll interval default/override, no-store, no
meta-refresh) and `tests/http/today-html.test.ts` (renderer shape,
escaping, poll-interval floor, no meta-refresh assertion).

## The capture route is the seam

`POST /capture` implements the remote-capture seam contract: it produces
exactly what `dome capture` produces — one raw-capture file under
`inbox/raw/` with `source: http` frontmatter, committed as one ordinary
human commit — and nothing else. `captureId` makes retries idempotent: the
id drives the filename slug, and an existing file for the same id answers
`status: "duplicate"` with the original path, writing and committing
nothing. The daemon compiles captures in the background; `compile_pending`
in the response reports whether a running serve host will pick it up.

The 11pm phone loop this enables: an iOS Shortcut with **Dictate text** +
**Get contents of URL** (POST, JSON body, the bearer token in a header)
against the vault machine over Tailscale — no SSH, no Mac-side shell.
`dome recipe ios` prints the full client-side setup ([[wiki/specs/cli]]
§"`dome recipe`").

## Trust domain

Binds `127.0.0.1` by default; `--host` points it at a private
(Tailscale-class) interface. The token comes from `--token` or
`DOME_HTTP_TOKEN`; the server refuses to start without one. This is an
owner-trust-domain surface like `dome mcp` — a hosted multi-tenant variant is
broader-deployment territory and out of scope. Dome Home's remote posture is
instead one owner, paired device identities, and a configured private HTTPS
transport; see [[wiki/specs/product-host]].

### Loopback browser pairing (P1 development Adapter)

`dome http --pair-code <code>` (or `DOME_PAIR_CODE`) enables `POST /pair`
and `GET /pair/status` only when the listener binds loopback. A successful
exchange returns an opaque, process-local `HttpOnly; SameSite=Strict` cookie;
the console code and compatibility bearer never enter browser storage.
Sessions expire after 12 hours and five failed exchanges in one minute are
temporarily limited. Pairing can start the loopback listener without a
separately configured bearer; the process creates an unexposed compatibility
token for its internal server contract. Browser pairing and cookie-authorized
mutations reject non-loopback `Origin` values; a second loopback port is
accepted for the Vite development proxy. Non-browser callers without an
`Origin` still use the compatibility bearer Interface.

This Adapter proves the P1 installed-browser journey. It is intentionally not
the P3 device-authority Interface: sessions do not survive restart, the code is
reusable for local recovery, devices have no independent grants/revocation,
and non-loopback binds are refused. Remote exposure remains disabled until P3
ships persistent device identity, exact-origin/CSRF enforcement, auth epochs,
and local-console recovery.

### Dome Home durable device authentication

The Product Host uses the same route implementation in a distinct auth mode;
it never falls back to the compatibility bearer, query token, or process-local
pairing cookie. `POST /pair` exchanges a `dome devices pair` grant for a
host-only `HttpOnly; SameSite=Strict` device cookie and a double-submit CSRF
cookie. HTTPS origins always receive `Secure`; an explicitly configured HTTP
loopback development origin omits it, and insecure non-loopback pairing is
refused before the grant is consumed.
`GET /pair/status` reports the authenticated device and exact grants.
Cookie-authenticated mutations require an exact configured `Origin`, the CSRF
cookie, and matching `X-Dome-CSRF`. On reload the PWA copies that readable,
non-authorizing cookie into memory; no bootstrap mutation races multiple tabs.
Bearer device
credentials do not require CSRF, but any supplied Origin must still be exact.

All authenticated routes receive a frozen device context. Route capabilities,
readiness, transcription, agent tools, and session ownership derive from that
context. Persistent per-request mutation audit receipts remain a P3.3
deliverable. Credential lifecycle failures share one public 401;
responses are no-store and carry CSP, frame, content-type, referrer,
permissions, and request-id hardening headers.

### One shared bearer token (the v1 compatibility contract)

The token is a **single static shared bearer** for the whole surface: one
secret, configured once on the host, presented by every caller (header on
every route, `?token=` on `GET /today`). There is no per-device issuance, no
per-device identity, and no rotation primitive — rotating means editing
`DOME_HTTP_TOKEN` (or `--token`) and restarting, which invalidates every
device at once.

This is a **deliberate v1 scope cut, not an oversight.** The v1 plan's scope
decision floated "per-device token issuance/rotation from day one"
([[cohesive/brainstorms/2026-06-11-dome-v1-plan]] §Scope decision, §WS3); v1
ships the single token instead, and this section is its normative record. The
reasoning:

- **The multi-device driver is remote MCP, which is deferred.** Per-device
  tokens earn their keep when distinct, possibly-non-owner devices each hold
  credentials that can be revoked independently — the remote-MCP /
  claude.ai-connector world. That world is explicitly deferred for v1
  ([[cohesive/brainstorms/2026-06-11-dome-v1-plan]] §WS3: remote MCP needs a
  public always-on endpoint; the always-on-host decision reopens with it).
  Until then every credential holder is the owner inside one
  loopback/Tailscale trust domain (§"Trust domain"), where a shared secret and
  a same-network exposure boundary are the actual security contract.
- **Issuance/rotation lands with or before remote MCP**, not on its own
  schedule. When a credential might belong to a device the owner does not
  physically control, per-device issuance and independent revocation become
  load-bearing and ship as part of (or ahead of) opening the surface beyond
  the trust domain — the same gate that reopens the exposure decision.

The accepted-for-v1 record is also in
[[cohesive/second-user-blockers]] §"Security posture to document".

### Request-body cap

Even inside the trust domain, the server runs 24/7 and must not buffer
unbounded bodies: POST bodies over `maxBodyBytes` (default 1 MiB,
`DEFAULT_MAX_BODY_BYTES`) answer `413` `payload-too-large` with the standard
error envelope, before anything is written to the vault. The handler owns
the check — a declared `content-length` over the cap is rejected without
reading, and the body stream is read with a byte budget so chunked or
lying-length bodies cut off at the cap on any host. `dome http` additionally
sets Bun's `maxRequestBodySize` (at twice the cap) as a backstop; Bun's
limit alone is not sufficient because Bun 1.2.x does not enforce it on
chunked bodies, and Bun's own rejection is a bare 413 without the envelope.
Tests: `tests/http/http-server.test.ts` §"request-body size cap".

## Boundary notes

- **No engine control.** No sync/serve/init/rebuild routes; the daemon owns
  compilation. The write-ish routes (`capture`, `resolve`, `settle`, `apply`,
  `reject`, and agent writes under `author`) are the established non-engine
  channels (ordinary commit; `answers.db`; `proposals.db` CAS). Agent writes
  (`create_document` / `edit_document`) require the `author` capability
  (`--allow-write`).
- **One runtime at a time.** A route mutex serializes vault-opening work;
  each request opens and closes its own `Vault`, like one CLI invocation.
- **No new dependencies.** The handler is a plain `fetch` function for
  `Bun.serve`; nothing here is reachable from the static import graph of
  `src/index.ts`.
- **Shared operations, thin transport.** Behavior used across protocols lives
  in `src/surface/`; HTTP owns only auth, status codes, request parsing, SSE,
  and static delivery. There is no additional aggregate surface object.

## Related

- [[wiki/specs/capture]] §"The remote-capture seam" — the contract
  `POST /capture` implements.
- [[wiki/specs/task-lifecycle]] §"The settle operation" — the contract
  `POST /settle` implements.
- [[wiki/specs/mcp-surface]] — the sibling stdio adapter.
- [[wiki/specs/cli]] §"`dome http`" — the verb.
- [[wiki/matrices/protocol-adapter]] — the per-protocol operation map.
