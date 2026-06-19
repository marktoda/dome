---
type: design-brief
tags:
  - design
  - mobile
  - pwa
  - clients
created: 2026-06-18
status: active
sources:
  - "[[wiki/concepts/client-model]]"
  - "[[cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client]]"
  - "[[docs/superpowers/specs/2026-06-16-pwa-design]]"
  - "[[VISION]]"
description: "Design brief for an external designer doing a full design pass of the Dome PWA — the phone surface to a personal 'second brain'. Vision, principles, surfaces, real data shapes, flows, constraints, and where we want the designer's judgment."
---

# Design brief — the Dome phone app (PWA)

**For:** a product/visual designer doing a full design pass.
**From:** the Dome team (a one-person tool, today).
**What we need:** a cohesive visual + interaction design for a phone app that already works functionally but looks like a competent engineer's placeholder. You have wide latitude on the look and feel; this memo pins the few things that are load-bearing and hands you everything else as opportunity.

You do **not** need to know anything about Dome's internals. This brief is self-contained.

---

## 1. The one-paragraph version

Dome is a **personal "second brain"** — a private, ever-growing knowledge base of someone's notes, decisions, tasks, and the connections between them, kept as plain text and quietly organized by an AI in the background. On the desktop the owner already lives in it through a chat-style AI assistant. **This app is that brain in your pocket.** It does three things: let you **capture a thought by voice** the instant you have it, **ask your brain a question** and get a synthesized, sourced answer, and **glance at what's going on** — today's tasks, open questions, and what's recently changed. The feeling we want is **calm, fast, and trustworthy** — the opposite of a noisy productivity app. It should feel like a quiet instrument, not a dashboard.

---

## 2. Who it's for

- **One user, today: the owner.** This is a tool someone built for themselves and uses every day. It is not a consumer growth product; there is no onboarding funnel, no marketing surface, no social layer. Design for a power user who already understands their own system.
- **The desktop habit we're porting:** on a laptop, the owner keeps two things side by side — a **glanceable "today" cockpit** (tasks, open loops, questions) and an **AI chat** they talk to (ask, capture, synthesize). The phone app compresses that same posture into one screen for when they're away from the desk.
- **Context of use:** mostly one-handed, on the go, in short bursts. Walking, in a meeting gap, in line. The single most important moment is **"I just had a thought and I want it captured before it's gone"** — by voice, in under five seconds, without ceremony.

---

## 3. The product thesis (read this twice)

Three convictions shape everything:

1. **The agent is the centerpiece, not a forms suite.** The heart of the app is a conversation surface (ask) and a capture surface (voice). We are deliberately *not* building a hand-crafted flow for every action (no "new task" wizard, no structured browser). The intelligence does the work; the UI is the frame around the conversation.

2. **Voice capture is the marquee bet.** We believe the killer interaction is: tap, speak your thought, see it transcribed, glance to confirm, file it. This needs to feel **magical and instantaneous** — it's the thing that makes someone reach for this app instead of a notes app. The review-before-filing step (you see the transcript and can fix it before it's saved) is a deliberate trust mechanism, not friction — but it must feel light.

3. **Signal-first calm.** Color is *signal*, not decoration. A normal day should look quiet. When something needs attention (an overdue task, an open question), that's where color and weight go. Crucially, **"you're clear" is a frequent, first-class, almost rewarding state** — not an empty-state afterthought. Most days, opening the app should feel like a calm exhale, not a wall of red badges.

The supporting frame is small and fixed: **a brief** (what's going on today) and **a recents list** (what's recently changed). That's the "opinionated" part — a few always-there glance panels so the app is never just a blank chat box. Don't add more panels; make these two sing.

---

## 4. Design principles (the non-negotiables)

- **One screen, one column, thumb-first.** Phone portrait. The capture/ask input is pinned within thumb reach. No nav bar, no tabs, no hamburger — everything lives on a single scroll.
- **Calm by default, signal on demand.** Quiet baseline; reserve emphasis (color, weight, motion) for things that actually need the eye.
- **Provenance is visible.** When the AI answers a question, it cites the notes it drew from. Those citations are a trust feature — design them as first-class, not a footnote.
- **Speed is a feature.** It's served from the owner's own small home server; perceived latency matters. Streaming answers should feel alive (text arrives token-by-token). Capture should feel instant even while transcription runs.
- **Fewer, better states.** Every surface needs a considered loading, empty, error, and "all-clear" state. These are not edge cases here — the all-clear brief is the *common* case.
- **No account, no chrome.** First run is a single token field (think "paste your access key"), then you're in. Don't design a sign-up.

---

## 5. The screen — anatomy

A single vertical screen, top to bottom:

```
┌─────────────────────────────────┐
│  Dome            (masthead/ID)   │   ← quiet identity; maybe today's date / status
├─────────────────────────────────┤
│  BRIEF                           │   ← "today · 3 open"  or  "today · all clear"
│   ⚠ hero line (the one thing)    │
│   ◦ open tasks (· due date)      │
│   ◦ follow-ups                   │
│   ? questions  [option][option]  │   ← tap an option to answer inline
├─────────────────────────────────┤
│  ▸ recents (5)        collapsed  │   ← expandable; title · who · when
├─────────────────────────────────┤
│  CHAT TRANSCRIPT                 │   ← grows as you ask; answers stream in
│   you: when is the launch?       │
│   dome: …streamed answer…        │
│        [wiki/launch.md] [chip]   │   ← citation chips
├─────────────────────────────────┤
│  [🎤]  ask your brain…     [↦]   │   ← PINNED composer: mic + text + send
└─────────────────────────────────┘
```

The four surfaces, in priority order:

1. **Composer (pinned, bottom).** The hero. A text field to ask, a mic button to capture by voice, a send affordance. This is where the app is *used*. When recording, it transforms; when reviewing a transcript, it becomes an edit-and-confirm surface (see Flow A).
2. **Chat transcript.** An append-only conversation log. User questions and streamed AI answers, each answer trailed by citation chips. Empty until you ask.
3. **Brief.** Today's situation: a possible "hero" (the single most important item), open tasks (some with due dates), follow-ups, and questions the system wants answered (each with tappable options). Or the all-clear state.
4. **Recents.** Collapsed by default. A short list of recently-touched knowledge pages — title, whether *you* or *the AI* last changed it, and how long ago.

You decide the actual spatial arrangement, hierarchy, and whether brief/recents sit above or below the transcript, collapse, dock, etc. The above is the current build, not a mandate.

---

## 6. The core flows (with states)

### Flow A — Voice capture (the marquee moment)
The lifecycle, today, is a small state machine. Design the *feeling* of each transition:

`idle → recording → transcribing → review → filing → confirmed → idle`

1. **idle** — mic button at rest, inviting.
2. **recording** — tap the mic; it's now listening. Needs an unmistakable "I'm recording" state (the button becomes a stop control). Consider live feedback (a waveform, a pulse, a timer).
3. **transcribing** — tap stop; audio goes to the server to be transcribed. A brief "transcribing…" beat. Keep it feeling fast even if it's a second or two.
4. **review** — the transcript appears in an **editable** field with "File" and "Cancel". This is the trust step: the user reads what was heard and can fix it. Make it feel like confirmation, not data entry.
5. **filing → confirmed** — "File" saves it; a light confirmation ("captured"), then back to idle. Reassure that it's safely stored.
- **Error states:** mic permission denied; transcription failed; save failed. Each needs a calm, recoverable treatment (not a stack trace).

This flow is where we most want your craft. It should feel like the app *wants* your thoughts.

### Flow B — Ask your brain
- Type (or, later, speak) a question → send. The user's message appends to the transcript; the AI's answer **streams in token-by-token** (design the in-progress state — a cursor, a shimmer). When done, **citation chips** appear under the answer (each is a source note the answer drew from). Tapping a chip is a future "open the source" affordance (not in v1, but design with it in mind).
- Errors (timeout, model unavailable) append as a calm inline note, not a modal.

### Flow C — Glance at the brief
- Open the app → the brief is *there*, current. The eye should land on the **hero** (the one thing that matters most) if there is one. Open tasks and follow-ups read as a calm list; due dates are a subtle signal, overdue a stronger one. **Questions** are special: each is something the system wants the user to decide, shown with **tappable answer options** — one tap answers it and the brief refreshes. This is the only "structured input" in the app; make it feel effortless.
- **All-clear:** when there's nothing open, this is a designed, almost-rewarding calm state ("You're clear."). Most days look like this. Don't treat it as empty.

### Flow D — Recents
- A glance at what's recently changed in the brain — yours or the AI's edits. Title, a who/when line. Collapsed by default; expanding is a peek, not a destination. (No page viewer in v1 — tapping doesn't open the page yet.)

### Flow E — First run
- One screen: a short "enter your access token" field (it's a private key, treated like a password) and a "Connect" button. Stored on-device after that; the user never sees it again. Design this as a quiet, confident handshake — not a login page.

---

## 7. The real data the screens render

**Please mock against this, not invented content** — the shapes are fixed by the backend, and real content breaks pretty mockups (a 4-line task, an 11-citation answer, a day with nothing open). Representative payloads:

**The brief** (`/tasks`):
```json
{
  "date": "2026-06-18",
  "hero": { "kind": "question", "item": { "id": 7, "question": "Ship the recents route this week or next?", "options": ["this week", "next week"] } },
  "openTasks": [
    { "text": "Draft the Q3 roadmap section on mobile", "dueDate": "2026-06-20" },
    { "text": "Reply to the design contractor", "dueDate": null }
  ],
  "followups": [
    { "text": "Circle back with Priya on the auth spike", "dueDate": null }
  ],
  "questions": [
    { "id": 7, "question": "Ship the recents route this week or next?", "options": ["this week", "next week"] },
    { "id": 9, "question": "Is 'Robinhood Chain' the same entity as 'RH L2'?", "options": ["yes, merge", "no, distinct"] }
  ],
  "counts": { "openTasks": 2, "followups": 1, "questions": 2 }
}
```
All-clear day: `openTasks: [], followups: [], questions: [], hero: null, counts: {0,0,0}`.

**Recents** (`/recents`):
```json
{ "count": 3, "entries": [
  { "title": "Robinhood Chain", "changedBy": "engine", "lastChangedAt": "2026-06-18T14:02:00Z", "subject": "consolidate duplicate entity" },
  { "title": "Q3 Roadmap",      "changedBy": "human",  "lastChangedAt": "2026-06-18T09:30:00Z", "subject": "add mobile section" },
  { "title": "Auth spike notes","changedBy": "human",  "lastChangedAt": "2026-06-17T18:10:00Z", "subject": "capture meeting" }
]}
```
`changedBy` is `"human"` or `"engine"` (you vs. the AI) — a meaningful, designable distinction. `lastChangedAt` renders as relative time ("2m ago", "5h ago", "2d ago").

**An answer's citations** (after a streamed reply): an array of `{ path }` like `[{ "path": "wiki/entities/robinhood-chain.md" }, { "path": "notes/2026-06-12.md" }]`. A path is a file location; the *title* isn't always in the payload, so design chips that look right showing a path-like string (and degrade for long paths). Answers can have **zero to ~12** citations.

**Capture result:** filing a note returns a confirmation with a path like `inbox/raw/2026-06-18-1432-buy-oat-milk.md` and a status (`captured` / `duplicate`). Design the "captured" confirmation.

Edge content to design for: very long task text; a task with no due date vs. an overdue one; a brief with only questions and no tasks; a single hero with an empty rest; an answer still streaming; an answer that errored mid-stream; 0 recents; 12 citations.

---

## 8. States to design (checklist)

For each surface: **loading**, **empty/all-clear**, **error**, **populated**, and (composer) the **recording/transcribing/review** states. Plus: first-run token gate, offline (a capture made with no connection — deferred to a later version, but worth designing the affordance), and the streaming-in-progress answer.

---

## 9. Constraints (what's load-bearing for buildability)

- **It's a PWA** (a website that installs to the home screen), primarily **iOS Safari**, phone portrait. It should be **installable** (home-screen icon, standalone — no browser chrome) and respect the notch/safe areas (`viewport-fit=cover`).
- **Single origin, single column, no router.** One screen; no client-side routing/tabs in v1.
- **The mic requires HTTPS** (a browser security rule) — fine in production (the home server uses HTTPS), just know it's why this is a real PWA and not, say, a LAN page.
- **No heavy UI framework is currently used** (hand-written CSS, system fonts, no icon library). You're **welcome to propose** a design system, icon set, type choices, motion, even a light theme — just flag dependencies, since this ships from a tiny self-hosted server and we value a small, fast bundle. Custom web fonts are fine if justified.
- **Accessibility & ergonomics:** one-handed use, large tap targets (especially the mic and the question-option buttons), legible at a glance in sunlight and in bed (so: both **dark and light** are worth considering — today it's dark-only). Honor reduced-motion.
- **Performance:** served from a small home server over a private network; design for snappy first paint and a small footprint. No multi-megabyte hero imagery.

---

## 10. The starting point (what exists today)

There's a **working, fully-functional implementation** — all the flows above work; it just looks utilitarian. The current aesthetic is a placeholder we call **"Quiet Terminal Calm"**: warm-dark (`#111` bg, `#e8e8e8` text), `system-ui` for prose + monospace for data, a **muted sage-green** accent (`#c8f0d8`) for calm/all-clear, **warm amber** (`#f0d08a`) for the hero/attention line, soft periwinkle for the user's own messages, hairline borders, a 42rem max column, a 56px pinned composer. It's a competent baseline and a reasonable *direction* (calm, terminal-adjacent, signal-as-color) — but treat it as a **point of departure, not a constraint.** You can evolve it or replace it.

Reusable structure already exists as named components (`Brief`, `Recents`, `ChatTranscript`, `Composer`, the token gate) — so a redesign maps cleanly onto real building blocks; you're not designing into a void.

**To see it live** (so you can feel the real interactions, not just static mocks): the team can run it locally and screen-share, or stand up the home-server instance for you to use on a real phone. Ask for a 20-minute walkthrough — the voice-capture and streaming-answer moments don't read from screenshots.

---

## 11. Out of scope for v1 (don't design these yet — but know they're coming)

- **Voice for *asking*** (speaking questions, spoken answers/TTS) — v1 voice is capture-only. *Design the mic with this future in mind, though.*
- **Opening a source page** (tapping a citation or a recents item to read the note) — chips/items are visible but not yet navigable.
- **Offline capture** (queueing a capture made with no signal) — the plumbing exists; the UI affordance is a later version. Worth a light design thought.
- **Push notifications, multi-user/accounts, a native app wrapper.** Not in scope.

Designing with these on the horizon (especially voice-ask and tap-to-open-source) will age the design well; just don't build flows for them in v1.

---

## 12. Where we most want your judgment

Open questions we'd love a designer's eye on:

1. **The capture moment.** How do we make "tap, speak, confirm, filed" feel instant and magical? Recording feedback, the transcribe beat, the review-and-file gesture, the "captured" reassurance.
2. **The all-clear state.** It's the common case. How does "you're clear" feel earned and calm rather than empty?
3. **Information hierarchy of the brief.** Hero vs. tasks vs. questions — how does the eye land on the one thing that matters? How do due/overdue read as signal without alarm?
4. **Citations / provenance.** How do source chips convey trust without clutter, given they're path-like strings of varying length and count?
5. **Identity & masthead.** What's the quiet top-of-app presence? Does it carry the date, a status pulse, nothing?
6. **One surface, three jobs.** Brief + recents + transcript + a pinned composer on one scroll — what's the spatial logic? Does the transcript take over when you're in a conversation and recede when you're glancing?
7. **Motion & feedback.** Streaming text, recording pulse, the file confirmation, state transitions — where does motion earn its place, and where would it violate "calm"?
8. **Light mode & sunlight legibility**, iconography, type system, and whether a small design-system/token set is worth introducing.

---

## 13. Deliverables we'd love

- A visual language / token set (color incl. the signal palette, type, spacing, radius, motion).
- High-fidelity designs of the **single screen** in its key states: populated brief, all-clear, an active conversation with a streaming + a finished answer, recents expanded, and the **full voice-capture sequence** (idle → recording → transcribing → review → confirmed).
- The **first-run token gate**.
- Empty/loading/error treatments.
- Whatever reference/rationale helps the (small) team build it faithfully.

Pointers if useful: the functional spec is at `docs/superpowers/specs/2026-06-16-pwa-design.md`; the product framing is `docs/wiki/concepts/client-model.md`; the implementation lives in `pwa/`. But this memo is meant to stand on its own — start here.
