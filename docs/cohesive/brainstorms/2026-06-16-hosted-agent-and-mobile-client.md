---
type: brainstorm
tags:
  - design
  - v1
  - mobile
  - hosted-agent
  - clients
created: 2026-06-16
status: approved-design
sources:
  - "[[wiki/concepts/client-model]]"
  - "[[cohesive/reviews/2026-06-16-agent-contract-surface-audit]]"
  - "[[v1]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/specs/mcp-surface]]"
  - "[[VISION]]"
---

# Hosted agent + mobile client — architecture decision

Approved 2026-06-16. Decides how the [[wiki/concepts/client-model]] native surface is
actually built: a voice-first phone client backed by a hosted agent that can read,
search, synthesize, and capture against the vault. Successor to the client-model
concept and the [[cohesive/reviews/2026-06-16-agent-contract-surface-audit]] (which
established that authoring is bound to a co-located git checkout, and that nothing
in Dome hosts an agent today). Resolves the always-on-host question deferred in
[[v1]] §WS3.

## The decision

**Architecture A — a custom PWA talking to a self-hosted agent backend on an
always-on home server, over Tailscale.** The agent loop runs beside the vault
checkout and the daemon; the phone is a thin web client that owns its own voice
UX. Nothing is exposed to the public internet.

Two foundational choices pinned with it:

- **Always-on host: a home server on Tailscale** (dedicated mini-PC). The vault
  never leaves the owner's control; overnight gardens no longer depend on a laptop
  lid; the phone gets a stable private endpoint. This is the original 2026-06-11
  intent, now committed over the laptop-first deferral.
- **v1 phone scope: capture + ask + read** (NOT phone-side authoring). The phone
  does voice capture, ask-my-brain (synthesized, source-backed answers), and reads
  the brief + a recents list. Authoring (edit/commit pages) stays a desktop /
  co-located-agent activity. This keeps the v1 agent loop to read + capture +
  synthesis from the phone; full phone authoring is a later increment.

## The shape

```
Phone (PWA)                          Home server (always-on, on the tailnet)
  voice capture ──┐                    ┌─────────────────────────────────────┐
  ask / chat    ──┼── HTTPS over ────▶ │ agent backend (Claude API tool-runner)│
  brief + recents─┘   tailscale serve  │   tools = Dome CLI / filesystem / git │
                      (*.ts.net cert)   │ vault checkout + dome serve daemon    │
                                        └─────────────────────────────────────┘
```

- **Agent loop**: start with the Claude API **tool runner** (the agent calls Dome's
  read/search/capture operations as tools; synthesis happens in the loop). Because
  the loop sits on the host with the checkout, *authoring is structurally available*
  — it's simply out of scope for the v1 phone surface, not blocked.
- **Voice** (the bullish bet): `MediaRecorder → upload → server-side transcription`
  (e.g. Whisper), NOT the iOS Web Speech API (unreliable on Safari). Because we own
  the voice UI, both voice capture and voice conversation work — we are not subject
  to the Claude-app voice limitation noted below.
- **Networking**: `tailscale serve` publishes the backend at `https://<host>.ts.net`
  with a real Let's Encrypt cert — this clears the PWA mixed-content trap and needs
  **no public exposure**. Private mesh suffices because the phone talks to *our*
  backend, not to Anthropic.
- **Shell**: a **PWA**, not native — one web codebase served from our own backend,
  instant deploy, no signing ceremony. Upgrade to a **Capacitor wrapper of the same
  code** only if we later want the iOS Action Button one-press capture, background
  upload, or Focus-piercing push.

## Why A (the alternatives, and why not)

The research (2026-06-16, web + Claude Agent SDK / MCP docs) mapped three coherent
architectures. "Hosted agent" decomposes into two orthogonal choices — *where the
agent loop runs* and *what the phone shell is* — plus one hard dependency (the
always-on host).

| | A. Our PWA + our backend | B. Managed Agents (self-hosted sandbox) | C. Claude app + remote MCP |
|---|---|---|---|
| Loop runs on | our host (tool runner) | **Anthropic**; tools on our outbound-only worker | Anthropic (Claude app) |
| Phone shell | our PWA (we own voice) | our PWA + session-driver | the Claude app |
| Authoring | ✅ native (co-located checkout) | ✅ via tools the worker exposes | ⚠️ only if we expose write/commit MCP tools |
| Voice-first | ✅ we own the mic UX | ✅ we own the mic UX | ❌ **Claude app voice can't call MCP tools (mobile)** |
| Exposure | **Tailscale private** | outbound-only (no inbound) | ❌ needs a **public** HTTPS endpoint |
| Maturity | stable (plain API) | **beta**; no cross-session memory self-hosted | stable but constrained |

**Why not C:** the tempting shortcut (point the Claude iOS app at a Dome remote-MCP
server) fails the voice requirement — the Claude app's voice mode can't call MCP
tools today (desktop-only) — *and* a custom remote-MCP connector needs a public
HTTPS endpoint, exposing the brain's tools to the internet. It survives only as an
optional **secondary desktop surface**: a read/search/capture remote-MCP server (no
write tools, behind Cloudflare Access) gives "ask my brain from the Claude desktop
app" for free, without compromising the private phone path.

**Why not (only) B:** Managed Agents self-hosted sandbox is the same "tools on our
host" shape and is a fine **drop-in loop engine** if we later want Anthropic to own
long-session context/compaction — but it's beta, has no cross-session memory in
self-hosted mode yet, and still requires us to build the UI + a session-driver. So
it's an implementation option *inside* A's backend, not a different product.

## How this composes with the substrate

- **Client model** ([[wiki/concepts/client-model]]): this is the concrete build of
  the "native Dome surface" — an agent-centric shell (voice-first) framed by the
  brief cockpit + a recents panel. The agent is the primary client; the PWA is its
  shell.
- **Authoring boundary** (the audit's central finding): resolved via *co-locate the
  agent with a checkout* — and kept **private** over Tailscale, so no `propose-patch`
  contract change and no public write-tools. Phone-side authoring stays deferred by
  the scope decision above, not by the architecture.
- **The contract is still the product**: the phone's read/ask/capture all flow
  through the shared `src/surface/` collectors (capture, query/export-context for
  grounded retrieval, the today/brief view). The agent backend is a new *client* of
  that contract that happens to run server-side — plus the synthesis layer the
  contract deliberately doesn't provide.
- **Recents**: ✅ **SHIPPED 2026-06-16** — `GET /recents` on the ask-server
  (`dome.recents/v1`: recently-touched knowledge pages, git-derived via
  `src/surface/recents.ts`), powering the brief/recents panel.
- **[[v1]] §WS3**: the always-on-host decision is now made (home server on
  Tailscale); the remote-MCP-as-phone-frontend bet is superseded by our-own-backend
  for the phone, with remote MCP retained only as the optional desktop secondary.

## Sequencing (not yet planned in detail)

1. **Stand up the home server** on the tailnet; move `dome serve` + the vault onto
   it. This unblocks everything mobile and is the WS3 prerequisite.
2. **Agent backend** on the host — ✅ **SHIPPED 2026-06-16** (`src/agent/`,
   `dome ask-server`, `POST /ask` → `{answer, citations}`): a multi-step
   tool-calling loop over Dome's read collectors (query/today/readDocument) on
   the **Vercel AI SDK** (`generateText` + tools), bearer auth + bounded body +
   request timeout. It's a client of the contract, brings its own model
   (Anthropic via the AI SDK), and is a companion entrypoint (dynamic-import
   only, so the no-LLM-in-core fence holds). Remaining for this step: streaming
   (`streamText` + SSE) for the voice/chat UX, and serving it via
   `tailscale serve` once the host exists.
3. **PWA**: voice capture (MediaRecorder→transcription), ask/chat, brief, recents.
   Add-to-home-screen; IndexedDB capture queue flushed on open (no iOS background
   sync); Declarative Web Push for question nudges.

   **PWA backend topology** — the PWA talks to ONE backend = `dome ask-server`
   (one base URL, one token, one process). Beyond `/ask` + `/ask/stream`, the
   ask-server now also serves `POST /capture` (voice→note), `GET /tasks` (the
   brief: today's tasks/loops/questions), and `POST /resolve` (answer a
   Dome-raised question) — ✅ **SHIPPED 2026-06-16**. Those three reuse the SAME
   shared `src/surface/` collectors `dome http` uses (`performCapture`,
   `runCatalogView(today)`, `vault.resolve`), under the ask-server's existing
   single mutex, with identical request/response shapes + status codes — so the
   client gets the same contract whichever server it hits. Delegation to
   `dome http` was **rejected**: each server owns its own `makeVaultMutex()`, so
   composing them would allow two concurrent `VaultRuntime`s (a correctness
   hazard). `dome http` stays unchanged — the standalone lightweight read+capture
   adapter plus the `/today` HTML cockpit. **Recents** (`GET /recents` →
   `dome.recents/v1`, recently-touched knowledge pages) is now ✅ **SHIPPED** too.
   The ask-server also **serves the PWA static assets** (`--static-dir <path>` /
   `DOME_PWA_DIR` — `GET /` app shell + `GET /assets/*` static files, auth
   carved out so the browser can load the shell unauthenticated; `GET /healthz`
   is the PWA's liveness ping) and handles **voice transcription** (`POST
   /transcribe` with `--transcribe-cmd <cmd>` / `DOME_TRANSCRIBE_CMD`, space-split
   into argv and called with a temp audio-file path → returns `{text}`) — ✅
   **SHIPPED 2026-06-17** — so the ask-server is the PWA's **complete backend
   including voice-capture transcription**. The remaining PWA work is the React
   client itself (apiClient, Composer/ChatTranscript, Brief/Recents, capture
   queue, token gate, manifest + service worker) + the always-on host.
4. **Per-device tokens** (promised twice in v1, never delivered) land here.
5. **Optional**: read-only remote-MCP server behind Cloudflare Access for the Claude
   desktop app.

## Non-goals / open

- **Phone authoring** — deferred (scope decision). Revisit as a later increment via
  the same co-located loop.
- **Native app** — only if a Capacitor wrapper's gaps (Action Button, background
  upload, Focus-piercing push) become load-bearing.
- **Managed Agents** — kept as an optional loop engine, not a v1 dependency.
- **TTS/voice-conversation polish, transcription model choice, the agent backend's
  exact HTTP shape, and where it overlaps the existing `dome http` adapter** — for
  the plan.
