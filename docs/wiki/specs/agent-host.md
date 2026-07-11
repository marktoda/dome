---
type: spec
created: 2026-07-09
updated: 2026-07-09
sources:
  - "[[wiki/specs/harnesses]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/concepts/client-model]]"
  - "[[wiki/specs/sdk-surface]]"
description: "The replaceable foreground-agent host: client conversation sessions, agent workspaces, and the compiler seam shared by built-in and external agents."
status: stable
---

# Agent host

Dome has two independent forms of intelligence over one git-backed vault:

- a **foreground agent** acts synchronously for a user;
- the **Dome engine** compiles and tends committed state asynchronously.

They are peers over the vault. The agent is replaceable; the engine does not
know which agent is present. Markdown, git, adopted state, questions,
proposals, diagnostics, and plugin views are their shared language.

This spec defines the seams. It deliberately does not introduce a
product-shaped `VaultSurface`, standardized plugin categories such as
"working set," or another engine primitive.

## Topology

```text
Mobile or web client
  ├── session conversation ─────────────────────┐
  ├── reliable capture                          │
  └── known deterministic panels                │
                                                 ▼
                                           Agent host
                              ┌────────────────────────────┐
                              │ AgentRuntime               │
                              │  built-in AI SDK adapter   │
                              │  future Claude/Codex       │
                              │  future local model        │
                              └─────────────┬──────────────┘
                                            │
                                      agent workspace
                              ┌────────────────────────────┐
                              │ markdown checkout          │
                              │ ordinary filesystem + git  │
                              │ AGENTS.md                  │
                              │ Vault / CLI / MCP compiler │
                              └─────────────┬──────────────┘
                                            │ commits
                                            ▼
                                       Dome engine
                              ┌────────────────────────────┐
                              │ adoption + garden          │
                              │ scheduler + plugins        │
                              │ projections + ledger       │
                              └────────────────────────────┘
```

The HTTP process may host the agent and protocol adapters in one Bun process.
That deployment convenience does not merge their responsibilities.

## Client-to-agent seam

Clients converse with an `AgentRuntime`, not with a particular model SDK.
The runtime owns session history and returns Dome-owned events:

```ts
type AgentRuntime = {
  createSession(): AgentSession;
  getSession(id: string): AgentSession | null;
  closeSession(id: string): boolean;
};

type AgentSession = {
  readonly id: string;
  send(message: string, signal?: AbortSignal): AgentTurn;
};

type AgentTurn = {
  readonly events: AsyncIterable<AgentEvent>;
};

type AgentTurnRunner = (input: {
  question: string;
  history: ReadonlyArray<AgentMessage>;
  signal?: AbortSignal;
}) => {
  text: AsyncIterable<string>;
  finished: Promise<AgentDone>;
};
```

The interface carries text, citations, change receipts, completion, and
errors. It does not expose Vercel AI SDK `TextStreamPart`, Anthropic types, or
another provider's tool-call representation. Provider-specific types stay
inside the adapter. The runner contract itself is only text plus a final
Dome-owned result, so a non-AI-SDK agent does not need an AI SDK dependency.

The built-in adapter stores session history in memory. A process restart
ends those sessions; durable conversation storage is a separate product
decision. The session routes are the only conversation protocol, so every
client receives the same multi-turn semantics.

## Agent-to-compiler seam

A capable agent receives a real vault workspace:

1. a checkout containing ordinary Markdown and git history;
2. `AGENTS.md` orientation;
3. native filesystem and git operations supplied by its harness;
4. the compiler contract through the in-process `Vault` handle, CLI, or MCP;
5. optional views contributed by installed plugins.

General knowledge authoring remains a normal Markdown edit plus git commit.
The compiler host observes the commit and constructs the Proposal. There is
no general `remember`, `writePage`, or remote `submitProposal` operation.

The compiler contract supplies only what a checkout cannot cheaply or safely
reconstruct: adopted-ref status, synchronous adoption, operational findings,
durable questions, proposals, projection-backed reads, provenance, and
plugin view invocation.

The existing public `Vault` handle is the in-process adapter at this seam. It
owns runtime lifecycle and adopted-state consistency. CLI and MCP are other
adapters over the same semantics. A second product-facing vault abstraction
would add indirection without a second behavior to hide.

### Subordinate agent work

Open `agent-safe` questions are the narrow slice where subordinate
intelligence earns its cost. `Vault.agentWork()` compiles revisioned packets;
the agent reads the referenced Markdown through native filesystem tools or
Vault recall; and `Vault.completeAgentWork()` requires inspected evidence and
an audit reason before durable resolution. The compiler is shared by direct
harnesses, the hosted agent, and background drains. It creates no job store:
deferred and failed attempts remain open questions. See
[[wiki/specs/agent-work]].

## Direct client operations beside conversation

The client may call deterministic operations without involving the agent:

- capture raw evidence;
- transcribe audio before capture;
- discover and render an installed plugin view directly;
- resolve a surfaced question;
- settle a plugin-owned task when a stable anchor exists.

This is not a second general authoring path. These operations are bounded,
idempotent state transitions where model reasoning would add latency and
failure modes. The agent's general authoring path remains Markdown and git.

## Plugin relationship

Plugins extend the compiler, not the agent interface. They register
Processors and communicate through Effects. View-phase processors may expose
arbitrary named, versioned `ViewEffect`s. Dome standardizes discovery,
invocation, validation, source scope, and error handling; it does not force
views into product categories.

A first-party client may contain a schema-aware renderer for a first-party
plugin. Unknown plugin views remain usable by agents and generic clients. A
shared semantic contract is introduced only after multiple real providers
must be interchangeable.

Plugin discovery reports installed command-triggered view processors. The
command trigger is the invocation name; the processor and owning extension
identify provenance. View name and structured schema remain runtime output
until a plugin manifest declares them in a future compatible extension.

## Three authorization domains

Do not conflate these policies:

1. **Client authorization** — whether a credential may converse, capture,
   read, resolve, or author.
2. **Agent workspace policy** — which paths and commands an agent runtime may
   access in its checkout.
3. **Processor capabilities** — which Effects a plugin processor may emit.

The existing HTTP capability vocabulary governs the first domain. Write
scope and harness tools govern the second. Manifest grants plus the
capability broker govern the third.

## Invariants

- The engine has no LLM- or agent-runtime dependency.
- The agent host never bypasses git-native adoption for general authoring.
- The client protocol exposes Dome-owned events, not provider SDK types.
- Session state belongs to the agent runtime, not the engine or projection
  store.
- Background processors continue when no foreground agent exists.
- Replacing the agent adapter does not change plugin or engine behavior.
- Plugin views are discovered by installed behavior, not a static
  first-party list.

## Related

- [[wiki/specs/harnesses]] — external harness compiler contract
- [[wiki/specs/http-surface]] — HTTP transport and current agent routes
- [[wiki/specs/sdk-surface]] — public `Vault` handle
- [[wiki/concepts/client-model]] — client taxonomy and authoring boundary
