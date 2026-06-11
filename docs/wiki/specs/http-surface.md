---
type: spec
created: 2026-06-10
updated: 2026-06-11
sources:
  - "[[wiki/specs/capture]]"
  - "[[wiki/specs/sdk-surface]]"
---

# HTTP surface

This spec is normative for `dome http` — the HTTP read+capture protocol
adapter (`src/http/server.ts`, hosted by the `dome http` verb). It is the
same surface class as the MCP adapter ([[wiki/specs/mcp-surface]]), lifted
onto HTTP for callers that can't mount stdio: phones, iOS Shortcuts,
scripts on other machines. It is also the first shipped form of the
remote-capture seam ([[wiki/specs/capture]] §"The remote-capture seam").

```text
src/http/server.ts — createDomeHttpServer({ vaultPath, bundlesRoot?, token }) → { fetch }
  ↓
dome http [--port 3663] [--host 127.0.0.1] [--token …]   (Bun.serve; one vault per process)
```

The adapter is deliberately thin and consumes the same data paths as the
MCP tools — the public `openVault` wrapper plus the protocol-neutral
`src/surface/` collectors ([[wiki/linters/surface-adapters-dont-import-adapters]]).
No parallel query or serialization logic; results are the same JSON
documents the CLI emits under `--json`.

## Routes

Every route requires `Authorization: Bearer <token>` (constant-time
comparison; 401 otherwise) — with one scoped exception for `GET /today`,
below. One vault per process.

| Route | Same path as | Result schema |
|---|---|---|
| `GET /` | — | `dome.http/v1` identity document |
| `POST /capture` `{text, title?, captureId?}` | `performCapture` with `source: "http"` | `dome.capture/v1` (`status: captured \| duplicate`) |
| `GET /status` | `dome status --json` | status snapshot (stable keys) |
| `GET /query?text=…` | `dome query --json` | `dome.search.query/v1` |
| `GET /tasks?date=…` | `dome run today` | `dome.daily.today/v1` |
| `GET /today?refresh=…` | the `dome.daily.today` view → `renderTodayHtml` | `text/html` cockpit page (`cache-control: no-store`) |
| `GET /doc?path=…` | `vault.readDocument` (adopted ref) | `dome.http.document/v1` |
| `GET /questions` | `vault.listQuestions` (open only) | `dome.http.questions/v1` |
| `POST /resolve` `{id, value}` | `dome resolve` | `dome.answer/v1` |

Errors are JSON envelopes (`{status: "error", error, message}`) with honest
HTTP codes: 400 usage, 401 auth, 404 missing, 409 unworkable git state,
503 adopted-ref churn, 500 the rest.

## The cockpit page (`GET /today`)

The one non-JSON route: it runs the same `dome.daily.today` view as
`GET /tasks`, then renders the structured result through `renderTodayHtml`
(`src/http/today-html.ts`, a pure data→HTML function with no engine imports)
into a phone-friendly dark-mode page — open tasks, follow-ups, and questions
with their `dome resolve` hints, or "All clear" when nothing is open. This is
the glanceable cockpit surface of the v1 plan; `dome today --watch` is its
terminal sibling.

Freshness is **dumb polling by design** (the v1 plan's open-questions
resolution): the page carries a `<meta http-equiv="refresh">` that reloads
its own URL. `?refresh=<seconds>` sets the cadence — a positive integer,
default 15 when absent or unparseable; the renderer floors it at 1. Because
the page reloads its own URL, a `?token=` parameter survives reloads.

The response is sent with `cache-control: no-store`: an authenticated page
whose URL can carry `?token=`, and whose freshness contract is the
meta-refresh — it must never be cached.

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
auth, GET-only scoping, refresh default/override, no-store) and
`tests/http/today-html.test.ts` (renderer shape, escaping, refresh floor).

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
owner-trust-domain surface like `dome mcp` — a hosted multi-tenant variant
is hosted-protected (v1.5) territory and out of scope.

## Boundary notes

- **No engine control.** No sync/serve/init/rebuild routes; the daemon owns
  compilation. The two write-ish routes (`capture`, `resolve`) are the
  established non-engine channels (ordinary commit; `answers.db`).
- **One runtime at a time.** A route mutex serializes vault-opening work;
  each request opens and closes its own `Vault`, like one CLI invocation.
- **No new dependencies.** The handler is a plain `fetch` function for
  `Bun.serve`; nothing here is reachable from the static import graph of
  `src/index.ts`.
- The planned `AbstractSurface` + `renderHttp(surface)` split
  ([[wiki/specs/sdk-surface]] §"Consumer surfaces") remains the target
  internal shape; this adapter swaps internals without changing routes when
  it lands.

## Related

- [[wiki/specs/capture]] §"The remote-capture seam" — the contract
  `POST /capture` implements.
- [[wiki/specs/mcp-surface]] — the sibling stdio adapter.
- [[wiki/specs/cli]] §"`dome http`" — the verb.
- [[wiki/matrices/protocol-adapter]] — the per-protocol operation map.
