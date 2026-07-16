---
type: spec
created: 2026-06-10
updated: 2026-07-16
sources:
  - "[[wiki/specs/capture]]"
  - "[[wiki/specs/sdk-surface]]"
  - "[[wiki/specs/task-lifecycle]]"
description: "HTTP contracts shared by Dome Home and the hidden standalone compatibility adapter."
---

# HTTP surface

> **Product posture:** Dome Home is the product lifecycle and hosts the paired
> PWA form of these contracts with durable scoped devices, exact-origin/CSRF
> enforcement, bounded sessions, and truthful readiness. The top-level `dome
> http` verb is hidden from default help and remains callable only as a
> standalone compatibility/development Adapter. It is not an onboarding path.

This spec is normative for the HTTP read+capture+converse protocol adapter
(`src/http/server.ts`), whether composed into Dome Home or hosted by hidden
`dome http`. It is
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

Dome Home supplies the production device contract in
[[wiki/specs/product-host]]: scoped credentials, local-console pairing,
revoke/rotation, browser cookie auth, exact Origin, and CSRF. The standalone
adapter's single bearer and process-local pairing modes are compatibility
contracts only and are not a public product security posture.

`--agent-log <path>` (or `DOME_AGENT_LOG=<path>`) enables a structured
per-turn log for `POST /sessions/:id/messages`: one JSON line per
request recording the granted capabilities, `authorEnabled`, `changes`,
`stopReason`, a 500-char `answerPreview`, `durationMs`, and any `error`. When
unconfigured the sink is a no-op with zero cost. Write errors are caught and
logged to stderr — they never propagate into the request path.

## Routes

Every data and operation route requires `Authorization: Bearer <token>`
(constant-time comparison; 401 otherwise). When a built PWA directory is
configured, its closed generated static routes are unauthenticated so an
installed shell can boot before device auth. The data-free `GET /today`
migration response is also public; it never authorizes an API request. One
vault per process.

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
| `GET /task-backlog?date=…&limit=…&cursor=…` | `dome run task-backlog` | `dome.daily.task-backlog.list/v1` |
| `GET /today` | legacy browser bookmark migration | `308` to `/` when the PWA shell is present; otherwise a data-free `410` notice |
| `GET /doc?path=…` | `vault.readDocument` (adopted ref) | `dome.http.document/v1` |
| `GET /source?path=…&commit=…` | exact adopted-source reader | `dome.source-document/v1` with explicit `status` |
| `GET /questions` | `vault.listQuestions` (open only) | `dome.http.questions/v1` |
| `POST /resolve` `{id, value}` | `dome resolve` | `dome.answer/v1` |
| `POST /settle` `{blockId, disposition, deferUntil?}` | `performSettle` (`resolve` capability — settling is a decision, same trust domain as resolve) | `dome.settle/v1` (`status: settled \| not-found \| invalid`) |
| `POST /task-backlog/review` `{schema, revision, decisions[]}` | `performSettleBatch` (`resolve`; one locked workspace mutation + receipt) | `dome.task-backlog.review/v1` (`settled` or typed invalid/stale/conflict/busy/outcome-unknown) |
| `GET /proposals?all=1` | `collectProposals` (`read` capability; defaults to pending rows only) | `dome.proposals/v1` |
| `POST /apply` `{id}` | `performApply` (`resolve` capability — the settle pattern for garden-proposed edits) | `dome.apply/v1` (`status: applied \| stale \| not-found \| not-pending \| invalid`) |
| `POST /reject` `{id, note?}` | `performReject` (`resolve` capability) | `dome.reject/v1` (`status: rejected \| not-found \| not-pending \| invalid`) |
| `POST /sessions` | create an in-memory foreground-agent session (`converse` capability) | `dome.agent-session/v1` |
| `POST /sessions/:id/messages` `{message}` | multi-turn `AgentRuntime` turn | strict `dome.agent.stream/v1` SSE events |
| `POST /sessions/:id/cancel` | idempotently abort the active owned turn | `dome.agent-session/v1` |
| `DELETE /sessions/:id` | close an agent session | `dome.agent-session/v1` |
| `POST /transcribe` audio body | STT step: shell command or OpenAI-compatible cloud endpoint (`capture` capability; 501 when unconfigured) | `dome.transcribe/v1` `{text}` |
| `GET /recents` | recent changes from the current branch's adopted ref (`read` capability; empty before initialization) | `dome.recents/v1` `{count, entries}`; every entry carries its exact newest-change commit |

`GET /task-backlog` is the read-only `TaskBacklog.list` seam for reviewed
cleanup. It reads the individual `dome.daily.open_task` origin facts selected
by the same global open-loop index as Today, before Today's glance-oriented
near-duplicate display fold. It groups only exact normalized visible text,
across the complete set before pagination; a duplicate candidate is therefore
one page unit and is never split across cursors. Each member retains exact
adopted commit+range+stableId SourceRefs, source title/context, and `blockId`.
Duplicate block anchors are detected across the full open set and make every
affected member/unit non-reviewable with collision-free source-located read
ids. An unanchored member remains
visible with `reviewable: false`; the surface never invents a settlement
identity. Group counters describe the complete snapshot, not only the current
page.

Pagination is deterministic and keyset-based. The opaque cursor binds the
last unit id to the adopted commit and a hash of the derived unit list. A
malformed cursor returns `400 invalid-cursor`; any adopted/task-list change
returns `409 stale-cursor` and requires a fresh first page. Page size defaults
to 25 and caps at 100. Mutation is the separate
`POST /task-backlog/review` contract: every unique decision returns the exact
SourceRef from this revision-bound read, and the server re-reads that evidence
and re-scans global source state under the controlled-mutation locks rather
than trusting a paged read receipt. Mixed close/defer edits and Done-today
backlinks land in at most one attributable commit; keep-only and exact replay
land none. The PWA client
validates the discriminated union even on non-2xx responses, returning typed
`invalid-cursor` / `stale-cursor` recovery documents while rejecting malformed
problem payloads.

`GET /source` is the citation-resolution route. Both `path` and a full commit
OID are required. The path must already be canonical and vault-relative, must
name a Markdown file, and cannot enter `.dome/` or `.git/`. This deliberately
keeps product citation reads on user-owned knowledge rather than making engine
configuration or credential-shaped metadata remotely readable. The commit
must be the current adopted commit or one of its ancestors; an
arbitrary object present in the Git database is not readable through this
route. Responses are capped at 512 KiB; the Git Adapter probes uncompressed
blob size before reading or UTF-8 decoding the object. The closed
`dome.source-document/v1` contract reports `ok`, `invalid-path`,
`invalid-commit`, `not-adopted`, `not-found`, `too-large`, or `unavailable`.
The PWA defaults successful content to safe rendered CommonMark/GFM, including
inert Obsidian wiki-links, and retains an exact raw toggle. Raw HTML and remote
images are never activated by the rendered view.

The session routes are backed by **AgentRuntime** (`src/assistant/runtime.ts`).
The shipped adapter uses the co-located AI SDK loop in `src/assistant/`; a
different runtime can replace it without changing HTTP, the PWA, plugins, or
the engine. This foreground runtime is distinct from the `dome.agent`
background processor bundle that runs inside the garden phase.

AgentRuntime owns total/per-device session and active-turn admission, one turn
per session, idle/absolute/turn timeouts, completed-turn and context bounds,
and cooperative cancellation. A cancelled provider retains its active slot
until it actually exits. Admission failures are typed and map to bounded HTTP
errors with retry timing; expired sessions use 410 rather than being silently
recreated.

`contracts/agent-stream.ts` is the shared server/browser wire boundary. Every
event carries `schema: dome.agent.stream/v1`; `done` and `error` are terminal.
The decoder rejects malformed JSON/schema, invalid UTF-8, oversized frames or
text, multiple/post-terminal events, partial frames, and EOF without a terminal
event. Protocol failure is visible and retryable—never silently skipped.

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

Protected-operation errors are JSON envelopes (`{status: "error", error,
message}`) with honest HTTP codes: 400 usage, 401 auth, 404 missing, 409
unworkable git state, 413 oversized body, 503 adopted-ref churn, and 500 the
rest. Proposal-decision conflicts also use 409: `POST /apply` or `POST /reject`
on a proposal that is already decided, or `POST /apply` on one that has gone
stale.

## Closed PWA static root and legacy migration

The PWA is Dome's one browser product. It consumes the authenticated JSON
routes, including `GET /tasks` for the `dome.daily.today/v1` document, rather
than carrying a second server-rendered Today implementation.

When `staticDir` is configured, the unauthenticated static surface recognizes
only `/`, its GenerateSW-required `/index.html` alias,
`/manifest.webmanifest`, `/sw.js`, the generated
`/workbox-<8-hex>.js`, and one-level hashed `/assets/<name>-<hash>.<ext>`
payloads where `<ext>` is exactly `js` or `css`. Arbitrary root files,
unhashed or nested assets, other extensions, and every data/operation path
fall through to normal authenticated routing. A recognized but missing build
file is a 404.

The shell, manifest, and service worker use `cache-control: no-cache`; hashed
assets and the hashed Workbox runtime are immutable for one year. The service
worker scope is `/`. GenerateSW precaches only these build outputs, has no
runtime caching rules, and permits navigation fallback only for the exact root
path. In production Device/Home mode, authenticated documents and events
remain `no-store` and can never be mistaken for offline knowledge state. The
compatibility bearer surface is not the production PWA cache contract.

`GET /today` exists only to migrate old bookmarks. If the configured static
directory can serve its verified root shell, the route returns `308` with
`Location: /`. The location never copies query parameters, so an old
`?token=...` bookmark is scrubbed rather than propagated. If no PWA shell is
available, it returns a public, data-free `410 text/plain` notice pointing
programmatic callers to authenticated `GET /tasks`. Both responses use
`cache-control: no-store`.

There is no query-token authentication path and no standalone cockpit font
surface. Compatibility callers put the bearer in `Authorization`; Dome Home
uses paired device credentials. Tests: `tests/http/http-server.test.ts`
§"closed PWA static root" and §"GET /today".

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
it never falls back to the compatibility bearer or process-local pairing
cookie. `POST /pair` exchanges a `dome devices pair` grant for a
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
context. Every admitted device mutation receives a durable, device-attributed
request receipt. Assistant tool mutations are separate child operations that
share the foreground turn's request id; read tools and prompts are never
recorded. Admission fails closed, while a crash or lost post-mutation result is
preserved as recovery-required uncertainty rather than a replayable failure.
Credential lifecycle failures share one public 401. In production Device/Home
mode, responses are no-store and carry CSP, frame, content-type, referrer,
permissions, and request-id hardening headers.

### One shared bearer token (the v1 compatibility contract)

The token is a **single static shared bearer** for the whole compatibility
surface: one secret, configured once on the host, presented in the
`Authorization` header on every protected route. There is no per-device
issuance, no per-device identity, and no rotation primitive — rotating means
editing `DOME_HTTP_TOKEN` (or `--token`) and restarting, which invalidates
every device at once.

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
