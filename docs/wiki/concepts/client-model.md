---
type: concept
tags:
  - product-framing
  - architecture
  - clients
created: 2026-06-16
updated: 2026-07-11
sources:
  - "[[wiki/concepts/brain-companion]]"
  - "[[wiki/specs/harnesses]]"
  - "[[wiki/specs/mcp-surface]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/matrices/protocol-adapter]]"
  - "[[VISION]]"
description: "Dome's client model: the user never operates Dome directly — they operate a client over the compiled vault, and the primary client is an LLM agent. The CLI is admin/agent-tool/gap-filler, not an end-user surface."
status: stable
---

# Client model

Dome has three layers, and **the user never operates the middle one directly**.

```text
Clients   LLM agents and native apps that read · search · synthesize · write · capture
Dome      the compiler + the contract clients speak to (AGENTS.md · structured ops · adoption)
Vault     portable markdown + git — the user's asset
```

The vault is the asset. Dome is the compiler that keeps it coherent *and* the
contract clients consume. **Clients are what the user actually touches.** This
page names the client taxonomy and the load-bearing claim that follows from it:
the product is the contract, not any one client — and least of all the CLI.

The first shipped product instantiation of this model is **Dome Home**: one
owner, one vault, one supervised host, and many paired clients. Its PWA keeps
the agent conversation at the center, with Today and Activity as the fixed
frame and Capture globally available. Conversation is the primary interaction;
the vault remains durable truth. See [[wiki/specs/product-host]].

## The primary client is an LLM agent

The way the owner uses Dome today is: open Claude Code and talk to it. It
searches the vault, reads pages, synthesizes an answer, writes updates, and
commits — using whatever tools it has (filesystem, `Bash`, the Dome CLI, MCP).
The human surface is *the conversation*; the agent orchestrates everything
underneath.

This is the model, not an accident of the dogfood phase. The Dome Home phone
surface has the same shape: a PWA that can **search with an agent or capture a
thought** — not a form to fill. **Voice capture is the near-term bet** for the
agent's primary input on the phone (an agent in your ear over the Product Host),
not a deferred someday. One brain, many agents, every device.

So Dome's job is not to *be* the intelligence. It's to make **any** agent
excellent at *your* vault — oriented to your conventions, given grounded
retrieval, able to write back through the adoption loop. The agent brings the
reasoning; Dome brings the compiled, source-backed substrate and the contract.

## The three kinds of client

**1. Agentic harnesses — the primary client (today, and the power-user wedge).**
General-purpose LLM agents the user brings: Claude Code now; Cursor, Codex, a
phone agent-client over HTTP, a voice client later. Dome ships none of them.
Its contract with them is the **compiler boundary** ([[wiki/specs/harnesses]]):
per-vault `AGENTS.md` orients the agent at session start; the compiler host
turns committed native writes into Proposals; the structured-ops surface (CLI
verbs, the `dome mcp` tools, the HTTP routes) gives the agent typed operations
when it wants them. These optimize for *openness* — any tool, any conversation,
any model.

**2. Native Dome surfaces — an agent-centric shell with a thin opinionated
frame.** Dome ships these, but they are *not* a suite of hand-built flows
(prep mode, structured browse, inbox review). The design spec already exists:
it is the way the owner works on the desktop today — `dome today` as a
glanceable cockpit on one side, Claude Code on the other for asking,
synthesizing, and capturing — ported to the phone. So the app is
**an agent as the centerpiece** (a big chat box, and especially **voice
capture** — the near-term bet) **framed by a few static glance surfaces**:
- the **brief / cockpit** — today's tasks, open loops, questions, what's going
  on (the `dome.daily.today` content);
- a **recents history** — what you've recently looked at and touched (a new
  surface; derivable from git's recently-changed pages plus the run ledger's
  recent briefs/queries/captures).

"Opinionated" means exactly this small fixed set of always-there panels — not a
pure-agent void, and not a designed-flow suite. The agent is still the primary
thing; the static frame is what keeps it from being a blank chat box.

**3. The CLI — not an end-user client at all.** This is the correction this page
exists to make. `dome` is three things, none of them "the product surface a
user lives in":
- **Admin / ops** — `dome serve`, `dome install`, `dome sync`, `dome doctor`,
  `dome rebuild`. Running and repairing the compiler.
- **A tool agents invoke** — `dome query`, `dome export-context`, `dome status`,
  `dome resolve`, called from `Bash` by a harness that wants a typed operation.
- **A human gap-filler** — what you reach for when no agent is around.

The CLI's human ergonomics matter for the operator and the agent, not for a
notional end user browsing their brain in a terminal. Polish the CLI *for agents
and ops*; do not mistake it for the place the product is won.

## The product is the contract, not the client

Because clients are swappable and bring-your-own, the durable product surface is
the **contract every client consumes**. Three faces of one boundary:

1. **`AGENTS.md` orientation** — the per-vault instructions that make any agent
   good at this vault. The single highest-leverage artifact: its quality is a
   multiplier on *every* client.
2. **The structured-ops surface** — CLI / MCP / HTTP are protocol adapters over
   the same `Vault` and `src/surface/` operations
   ([[wiki/matrices/protocol-adapter]]); the engine never knows which client is
   calling. Plugin read views are discovered and generically invoked across
   adapters; other operations are extracted when a second real consumer earns
   the shared seam.
3. **The git-native write path + adoption loop** — clients write by producing
   commits (filesystem-native) or captures (remote); the engine adopts both
   identically. Authoring a *page*, though, needs a checkout — see §"The
   authoring boundary".

Invest here, and every client gets better at once. Invest in one client's
chrome, and only that client improves.

## The authoring boundary — read everywhere, write where there's a checkout

The contract is strong at *read* and deliberately narrow at *write*. Across the
CLI, the `dome mcp` tools, and the HTTP API, a client can mutate vault state in
exactly two ways: **capture** (append a raw note to `inbox/raw/`) and
**decisions** (resolve a question, settle a task, apply/reject a proposal —
answering things the engine or the gardener already raised). There is no
operation to create or edit a vault *page*:
[[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
means real authoring happens as an ordinary `git commit` the daemon adopts —
there is no `submitProposal` API.

The consequence the taxonomy has to absorb: **authoring is bound to a co-located
git checkout.** A filesystem-native harness (Claude Code on the desktop) has
one, so it reads · searches · synthesizes · *writes* · captures. A client
*without* a checkout — a phone app, a remote MCP client, the Claude iOS app —
can read · search · *capture* · *decide* (settle, resolve, apply/reject),
because decisions and captures are contract operations; what it cannot do is
*author* a page. So the full read/synthesize/write/capture loop in §"The
primary client is an LLM agent" is the **desktop** story; off the desktop it
is **read + ask + capture + decide** until a checkout is reachable.

This is a real fork, not a bug:

- **Co-locate the agent with a checkout** (the intended path): a hosted,
  Claude-Code-class agent runs on an always-on host beside the vault and the
  daemon, reachable from the phone. Authoring stays filesystem + git; the phone
  is a thin client to that agent. No new write contract — the work is the
  Product Host, remote reach, and paired device authority described in
  [[wiki/specs/product-host]].
- **Add a remote authoring operation** (a `propose-patch` verb over HTTP/MCP
  that constructs a Proposal from a client-supplied patch). This is the
  deliberate exception to "no `submitProposal`," opened only if phone-side page
  authoring becomes a requirement.

For v1 the phone client is **read + ask + capture + decide** — a coherent,
defensible scope. Phone-side page authoring waits on one of the two forks
above. And note that "ask" itself needs an agent *running somewhere*: the MCP
surface hosts no model (it is a typed read/capture front-end for harnesses
that already bring their own agent). The HTTP surface (`dome http`)
**co-locates the Dome assistant** (`src/assistant/` — a consumer surface
distinct from the `dome.agent` background processor bundle) behind
`POST /sessions` plus `POST /sessions/:id/messages` — the always-on-host
path: a replaceable, multi-turn agent runtime running beside the vault that a
phone can reach directly. The built-in adapter
speaks the contract: it holds the capture and decision tools
(capture/settle/resolve/proposals) gated by the same capability set as the
routes ([[wiki/specs/http-surface]] §"The assistant's tools"), so through it
the phone can capture and decide conversationally — still decisions, not
authoring. Only with `--allow-write` (the `author` capability) does the
assistant additionally gain page-write tools; without it the surface keeps
the default safe posture, and synthesis still comes from a client's own agent
if none is co-located.

## What "ask" and "recall" mean under this model

There is deliberately **no human-facing synthesis command in Dome** (no
`dome ask`). Asking is the *client's* job — the agent reads, retrieves, and
composes the answer. Dome's job is to make that answer *groundable*: grounded
retrieval (`dome query`, `dome export-context` — better than raw grep because
results are ranked, fact- and claim-aware, and carry SourceRefs) and provenance
the agent can trace back to an adopted commit. Synthesis lives in the client;
**evidence lives in Dome.**

The corollary: a "why do I believe X / when did this change" capability belongs
in the contract as something an agent can *call or read* (claims + `Dome-*`
trailers + the run ledger already make it traceable), not as a terminal command
a human runs.

## Design implications

- **Treat the contract as the product.** `AGENTS.md`, the shared collector
  surface, and the write path are where "convincingly useful" is decided.
- **Plugin views ship broadly by construction.** Register a command-triggered
  view and generic clients discover it. Add named UI/routes only when their
  ergonomics earn them.
- **Don't over-polish the CLI for end users.** Its audiences are agents and the
  operator.
- **The mobile unlock is a reachable agent over the product host** (always-on
  single-vault host + paired device credentials), with voice as the primary
  online capture input and durable text capture as the V1 offline boundary. The brief
  cockpit (`/today`) and a recents history are the static glance panels that
  frame it — components of the app, not the primary element and not the whole
  app.

## See also

- [[wiki/concepts/brain-companion]] — the product framing this client model serves
- [[wiki/specs/harnesses]] — the compiler-boundary contract for agentic harnesses
- [[wiki/matrices/protocol-adapter]] — CLI / MCP / HTTP / Voice as adapters over one surface
- [[VISION]] §"Two surface patterns"
