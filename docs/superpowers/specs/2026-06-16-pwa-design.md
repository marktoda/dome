# Dome PWA — v1 design spec

**Date:** 2026-06-16
**Status:** approved design (brainstorm)
**Context:** [[cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client]] (Architecture A), [[wiki/concepts/client-model]]. The ask-server backend is complete (`/ask`, `/ask/stream`, `/capture`, `/tasks`, `/resolve`, `/recents`); this spec is the **client** + the one missing backend piece (transcription).

## Goal

A voice-capture + text-chat PWA — the native surface of Architecture A. The owner talks to capture a thought, types to ask their brain, and glances at the brief + recents. One installable web app, served by `dome ask-server`, reachable on the phone over Tailscale.

## v1 scope (decided)

- **Voice-capture** (the bullish bet): record → transcribe → review → file a note.
- **Text-chat ask**: type → streamed, source-backed answer.
- **Brief** (read): today's hero/tasks/loops/questions.
- **Recents** (read): recently-touched knowledge pages.

**Deferred to v1.1+ (YAGNI):** voice-for-*ask* + TTS, push nudges, a page viewer / recents deep-links, the Capacitor native wrapper, multi-user/accounts, phone-side page authoring (stays a desktop activity per the client model), per-device tokens.

## Architecture

- **Stack:** React + Vite, built to static assets. **Served by `dome ask-server`** at `GET /` (app shell) + hashed `/assets/*`. One origin ⇒ the existing bearer token works with **no CORS**; the app fetches only the server it was served from.
- **One new backend route — `POST /transcribe`:** accepts an audio blob (multipart or raw body), shells out to a **local whisper** on the host (whisper.cpp / faster-whisper), returns `{ text }`. Same subprocess discipline as the model provider (a vault/host-configured command; audio never leaves the host). Bounded body + bearer auth + the ask-server's existing mutex posture. This is the only server change; all other routes already exist.
- **Auth:** a single bearer token, entered once in the app, stored in `localStorage`, sent on every request. Per-device tokens are deferred.
- **Offline / PWA:** web manifest + a minimal service worker (installability + offline app shell). A capture created while offline is queued in IndexedDB and flushed on next app-foreground (iOS has no background sync — server stays canonical).

### Components (each small, single-purpose, independently testable)

- **`apiClient`** — typed fetch wrapper over the ask-server routes (`ask` SSE stream, `transcribe`, `capture`, `tasks`, `resolve`, `recents`); injects the bearer token; one place that knows the wire shapes (`dome.ask/v1`, `dome.recents/v1`, `dome.daily.today/v1`, etc.). Pure I/O; mockable in tests.
- **`Composer`** — the pinned bottom input. Owns the capture state machine: `idle → recording → transcribing → review → filing → idle` (and `idle → asking` for text). Mic button drives `MediaRecorder`; text submit drives ask.
- **`ChatTranscript`** — append-only chat log; consumes the `/ask/stream` SSE (text deltas → a growing message; the final `done` event → citation chips). A reducer over stream events, unit-tested with canned events.
- **`Brief`** — renders `/tasks` (`dome.daily.today/v1`): hero, open tasks, follow-ups, questions; a question can be answered inline via `/resolve`. Collapsible.
- **`Recents`** — renders `/recents` (`dome.recents/v1`): title · when · human/engine. Collapsed by default. (No deep-link/viewer in v1.)
- **`captureQueue`** — IndexedDB-backed offline queue: enqueue on failure/offline, flush on foreground. Server is source of truth.
- **`tokenGate`** — first-run: prompt for the bearer token (and optional backend base URL if not same-origin), store in `localStorage`.

### Data flow

- **Voice-capture:** `Composer` records → `apiClient.transcribe(blob)` → transcript fills the text field for a **quick review/edit** → user taps file → `apiClient.capture(text)` → toast + the note lands in `inbox/raw/` (daemon ingests later). *Review step is intentional* (local whisper is imperfect; captures are durable).
- **Text-ask:** `Composer` submit → `apiClient.askStream(question)` → `ChatTranscript` renders streamed text + citations. (Errors/timeouts from the SSE `error`/`done` events surface in the transcript.)
- **Brief / recents:** fetched on load + on app-foreground (and a light poll while open); read-only renders. Resolving a brief question calls `/resolve` and refreshes.

### Screen (one scrollable view; phone-portrait first, centered column on desktop)

```
Dome                          ● updated 3s     ← masthead + live dot
today · 4 open    ⚠ <hero task/question>        ← brief header + hero
  open loops · follow-ups · questions …          ← brief (collapsible)
──────────────────────────────────────────
▸ recents (5)                                    ← collapsed; tap to expand
──────────────────────────────────────────
  <chat transcript — streamed answers + chips>
──────────────────────────────────────────
[🎤]   type a question…                    [↦]   ← composer (pinned bottom)
```

Reuses the CLI/cockpit "signal-first, calm" vocabulary (glyphs lead lines, color is signal not decoration, calm spacing, a frequent/important all-clear state). The composer (agent) is the centerpiece; brief + recents are the static glance frame.

## Testing

- **Unit (backend mocked):** the `Composer` capture state machine (each transition); the `ChatTranscript` stream reducer (canned SSE events → messages + citations); `Brief`/`Recents` renderers against the real `dome.*/v1` shapes; `captureQueue` enqueue/flush; `tokenGate`.
- **Backend:** `POST /transcribe` route test mocking the whisper subprocess (canned audio → `{text}`; bad/empty body → 400; 401 without token), mirroring the model-provider/`/capture` test patterns.
- **Manual smoke:** the full app against a local `dome ask-server` + whisper + a real vault (needs the host pieces; not in CI).

## Open items folded into the plan (not blockers)

- The exact `/transcribe` wire shape (multipart vs raw audio; the host whisper command config key — likely a `.dome/config.yaml` entry mirroring the model-provider command).
- Audio encoding from iOS Safari `MediaRecorder` (it emits `audio/mp4`/AAC, which whisper accepts) — confirm in the plan.
- Vite build → where the static assets live and how `dome ask-server` serves them (`GET /` + `/assets/*`), and the dev story (Vite dev proxy to the ask-server).

## Non-goals (restating, to bound the plan)

No accounts, no settings beyond token + backend URL, no page authoring/editing from the phone, no push, no native wrapper, no voice-for-ask/TTS — all explicitly v1.1+.
