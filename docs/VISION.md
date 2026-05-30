# Dome

> A compiler for your second brain.

Dome turns the thoughts, meetings, research, and ambient context of your work into a living markdown vault — and quietly keeps it coherent over time. You write into it from wherever fits the moment: voice on your phone, hotkey capture at your desk, a conversation with an AI in your terminal. Dome's compiler runs over your vault — watching, reconciling, indexing, cross-referencing — so what you wrote yesterday connects naturally to what you write today, four years from now.

You do not maintain Dome. You tend it. The compiler does the gardening; you supply the seeds and walk the rows.

## The idea

A memory that compiles itself.

Andrej Karpathy named the pattern: an LLM Wiki — raw sources stay immutable; an LLM incrementally compiles them into a living wiki of pages, indexes, and cross-references that grows richer over time. Dome is the productization of that pattern with one architectural commitment: **the compiler is the load-bearing thing, not any particular interface.** The vault lives on disk as plain markdown. You write into it from whichever surface fits. The compiler keeps the structure coherent regardless of where the writes came from.

The result is what we mean by a *brain companion*: ambient, always accessible, streamlined to talk to, allergic to ungrounded confidence, and patient enough to be useful in six months, in four years, in twenty.

## The four operators

The whole system can be expressed with four operators. Every interaction with Dome — capture, edit, query, automated maintenance — composes from these.

```text
Submit    Clients propose changes by writing into the vault.
Adopt     The engine adopts proposals into trusted semantic state.
Tend      Garden processors refine adopted state asynchronously.
Recall    Queries read adopted state and return evidence.
```

**Submit.** Anything that writes into the vault — your voice capture, your agent's edit, your phone's quick-note, a scheduled maintenance job — produces a Proposal. The Proposal is a commit range with a source identity. There is no special path for "trusted" writes; everything submits.

**Adopt.** The engine receives the Proposal and runs a fixed-point loop: compile the candidate tree, run adoption-phase processors, apply auto-patches, repeat until stable. On a clean fixed point, the adopted ref advances and the change becomes trusted state. On a blocking diagnostic, the user resolves and re-submits.

**Tend.** After adoption, garden-phase processors run async against the new trusted state — extract tasks, cross-reference entities, generate the daily brief, refresh embeddings. They emit effects: Patches (which re-enter as new Proposals), Facts (which land in the projection store), Questions (which surface in the inbox), External actions (which go through the outbox).

**Recall.** Queries read the latest adopted snapshot and the projection store, return evidence-backed answers. No claim without a SourceRef pointing into an adopted commit.

## The four core types

Every API surface, every spec, every test reduces to four types.

```text
Vault         A markdown directory plus the engine that maintains it.
Proposal      A commit range proposed for adoption. The only write path.
Processor     Code that reads a snapshot and returns effects. The only behavior unit.
Effect        What a processor returns. Seven kinds; closed taxonomy.
```

Everything else — first-party features, third-party plugins, integrations — composes from these. There is no separate "Hook," "Tool," or "Workflow" concept. Auto-cross-reference, intake compilation, daily-note generation, lint, search-indexing — every one of them is a processor that emits effects.

## What Dome is

- **A compiler over a markdown vault.** A compiler host watches committed changes, runs the adoption loop on each Proposal, fires garden processors after, and surfaces diagnostics. The first host is `dome serve`, which can run foreground like an LSP/watch process or under a background service. The compiler is what makes the vault self-maintaining.
- **A typed markdown vault.** Raw notes, sources, and clips on one side; a compiled wiki of entities, concepts, sources, and syntheses on the other. Bidirectional wikilinks. Index and log files as committed projections. Standard Obsidian-compatible markdown — open it in any editor and everything works.
- **A small, portable SDK.** Four concepts in the core — **Vault, Proposal, Processor, Effect** — and nothing else. The same SDK powers the desktop CLI, embeds in a native mobile or web app, and drives headless processor runs. The compiler runs anywhere the SDK runs.
- **A CLI for explicit operations.** `dome serve` and `dome sync` drive the compiler host; `dome status`, `dome check`, and `dome resolve` are the normal see-and-fix path; `dome query`, `dome export-context`, `dome today`, and `dome prep` read from adopted state; `dome inspect`, `dome doctor`, `dome lint`, `dome answer`, and `dome rebuild` remain available for debugging, compatibility, and maintenance. Invokable from any shell.
- **A first-party extension catalog.** Every Dome behavior — markdown parsing, indexing, cross-referencing, intake compilation, daily notes, search — ships as a `dome.*` extension bundle. The same registration path third-party extensions use. There is no "core feature" / "plugin feature" asymmetry.

## Two surface patterns

Dome interacts with the world through two distinct kinds of surfaces, and the design treats them differently.

**Native Dome surfaces** — the iPhone app, desktop app, web app, voice client. Dome ships these. The intake and recall flows are opinionated: deliberate UX for voice capture into `inbox/voice/`, share-sheets into `inbox/clip/`, hotkey quick-capture into `inbox/raw/`, guided recall and prep-mode briefings, structured review of pending wiki proposals. The compiler runs behind them; the surface controls the flow.

**Agentic harnesses** — Claude Code today; Cursor, OpenCode, Codex, future agent harnesses. Dome doesn't ship these; you bring your own. They're general-purpose; they read and write your vault using whatever tools they have natively. **Dome's contract with these harnesses is the compiler boundary**: per-vault `AGENTS.md` teaches the agent your vault's conventions at session start; the compiler host catches committed native writes and turns them into Proposals; the engine adopts; the CLI exposes named structured operations the agent invokes when it wants them.

Native surfaces optimize for friction (designed flows). Agentic harnesses optimize for openness (any tool, any conversation, any model). Both produce Proposals; the engine adopts every Proposal through the same loop, regardless of origin.

## What Dome is not

- Not a notes app, not a chat product, not a meeting recorder, not a wearable.
- Not a replacement for Obsidian, Notion, or Claude Code — it augments them.
- Not always-on. Capture is intentional and visible.
- Not opinionated about ontology. The wiki's structure emerges from what you actually talk about.
- Not a SaaS your memory is trapped inside. Dome's source of truth is a folder of markdown on your disk.

## Principles

**1. Markdown + git are the knowledge source of truth.** The vault's committed markdown plus git history are the durable user-owned substrate. Projection data such as search indexes, extracted facts, diagnostics, and committed catalogues can be re-derived from adopted markdown and deterministic processors. Operational history such as failed runs and pending external actions lives in the run ledger and outbox; it is audit/recovery state, not canonical knowledge.

**2. Every write is a Proposal; every Proposal goes through the engine.** There is no "trusted internal write" path. The same adoption loop runs against a human edit, an agent's write, a garden processor's auto-patch, an intake hook's compilation. One write contract; one adoption transaction; one set of diagnostics.

**3. Processors are pure: snapshot in, effects out.** A processor reads an immutable git snapshot and returns a list of effects. It never touches the filesystem, git, or SQLite directly. The engine is the only applier — that's what makes the contract reviewable and the runtime substitutable.

**4. Capabilities scope effects.** Each processor declares what it needs to do (patch which paths, write which graph namespace, call LLMs at what budget); the vault grants what it gets; the broker enforces the intersection at effect emission. Trust is per-capability, not per-source.

**5. Provenance is mandatory.** Every Fact carries a SourceRef pointing into an adopted commit. Every external side effect goes through the outbox with an idempotency key. Every processor run lands in the ledger. There is no claim without evidence, no external action without an audit row, no run without provenance.

**6. The compiler is universal; surface opinion is per-surface.** The same compiler runs over your vault regardless of which surface wrote into it. Native Dome surfaces layer opinionated UX on top; agentic harnesses bring their own UX. The compiler boundary — compiler host + engine + adopted ref + CLI + `AGENTS.md` — is the explicit contract that lets every surface coexist.

**7. Extensibility is uniform.** First-party features and third-party plugins ship as extension bundles registering processors via the same path. Adding a new behavior — for the SDK or for a single user's vault — is "write a processor; declare capabilities; ship a bundle." The four-concept core never changes. Years of features can land without touching the primitives.

## How it works

**Quick-capture from anywhere.** A phone widget, a voice memo, a share-sheet, a terminal hotkey, a file drop into `inbox/`. The capture writes raw markdown; the compiler host turns it into a Proposal; the engine adopts; garden processors compile raw → wiki updates while you walk.

**Talk to your agent.** Today that's Claude Code, with `CLAUDE.md` importing `AGENTS.md` so the agent arrives oriented to your vault. The agent reads pages, writes updates, proposes cross-references, asks for confirmation. Whichever tools it uses — native filesystem operations or Dome's CLI commands invoked via `Bash` — the compiler host catches committed writes, the engine adopts them, the projection store updates, the vault stays coherent.

**Browse in Obsidian** — or any markdown editor, or the Dome mobile app once it ships. Nothing about the vault is proprietary.

**Tend the garden periodically.** Weekly or monthly, `dome lint` reports stale claims, orphan pages, missing cross-references, contradictions, and schema violations from adopted state. When the engine needs a human decision, it asks a question; the user answers through `dome resolve`; recovery mutations stay inside normal processor/effect/capability routing instead of one-off admin commands.

**Ask, prep, brief, and hand off.** *"What did I decide about hiring last quarter?"* *"What should I bring up with Maya tomorrow?"* *"Produce a context packet for ChatGPT on the platform-ownership question."* The wiki is the durable thing across every AI tool you use; Dome's adoption-loop + projection store keep the answers grounded in adopted state.

## Audience

We build first for high-context operators — managers, founders, researchers, consultants, technical leaders — who already feel the pain of fragmented context across ten pinned AI threads. Their vaults grow dense fast enough to validate that the compilation pattern works. Their willingness to pay matches the value of the time they recover.

But the constraint that makes Dome work for them — *the compiler does the structural maintenance; the user just talks* — is the same constraint that makes it work for anyone. A student building a thesis bibliography. A writer maintaining character notes across a novel. A new parent tracking what their kid is curious about this month. A retiree organizing the family history. The product is general-purpose by design; the wedge is specific by sequencing.

## Shape over time

**v1 — The engine model.** A TypeScript SDK on Bun; a compiler-host CLI (`dome init`, `dome serve`, `dome sync`, `dome status`, `dome check`, `dome resolve`); advanced recovery and visibility commands (`dome inspect`, `dome doctor`, `dome answer`, `dome rebuild`); user-value views (`dome query`, `dome lint`, `dome export-context`, `dome today`, `dome prep`); a first-party extension catalog (`dome.*` bundles for markdown, graph, search, health, daily, intake, and lint); an optional future MCP Recall adapter; and a Bun.sqlite projection store + run ledger + outbox. Claude Code is the first agentic harness; `CLAUDE.md` imports `AGENTS.md` as the orientation surface; Obsidian browses the vault; git is the history. The author of Dome is its first user.

Notably, this repo's own `docs/` directory is itself a Dome vault — proof that the pattern generalizes beyond personal notes to systems-thinking substrate. Specs, invariants, behavior matrices, gotchas, syntheses about the project all live as Dome pages, maintained the same way a personal vault is.

**v1.5 — Hosted multi-client.** The adoption-loop design accommodates a hosted-protected mode: PRs against `main` become Proposals, the engine runs adoption in CI, engine commits land on the PR, the PR auto-merges or routes to review based on capability policy. The local-eventual and hosted-protected modes are conceptually the same loop with different cursors.

**v2 — Product.** Native mobile app: voice-first capture, structured browse, prep mode, inbox review. Native desktop. Voice client. Web app. Onboarding that meets each user where they are — a new vault, an existing Obsidian vault, a pile of Apple Notes, a stack of Google Docs. Same SDK underneath. Different surfaces above. The opinionated-flow patterns for native surfaces solidify here; the compiler boundary for agentic harnesses remains the contract.

**Long term.** Dome is what people use the way they use their phones: ambient, always there, low-friction. You think out loud; Dome remembers. You ask; Dome answers from your own thinking. The garden grows over years, and grows beautifully, because the gardening is automatic. The cognitive surface of an individual — what they pay attention to, what they decide, what they change their mind about — becomes a durable, exportable, queryable asset that compounds for a lifetime.

## Why this matters

The bottleneck on high-quality knowledge work is not capture. It is *coherence over time*. The hardest part of thinking deeply about anything is remembering what you already thought, finding the thread you dropped six weeks ago, noticing the contradiction between today's idea and last quarter's principle. Existing tools make capture easy and coherence impossible.

If Dome works, the cost of staying coherent across years drops to near zero. The hardest part of being a thoughtful person becomes the easy part — and everything else, better decisions, faster research, sharper writing, more durable relationships, fewer dropped threads, follows.

That is what we are building.
