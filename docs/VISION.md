# Dome

> A compiler for your second brain.

Dome turns the thoughts, meetings, research, and ambient context of your work into a living markdown vault — and quietly keeps it coherent over time. You write into it from wherever fits the moment: voice on your phone, hotkey capture at your desk, a conversation with an AI in your terminal. Dome's compiler runs over your vault — watching, reconciling, indexing, cross-referencing — so what you wrote yesterday connects naturally to what you write today, four years from now.

You do not maintain Dome. You tend it. The compiler does the gardening; you supply the seeds and walk the rows.

## The idea

A memory that compiles itself.

Andrej Karpathy named the pattern: an LLM Wiki — raw sources stay immutable; an LLM incrementally compiles them into a living wiki of pages, indexes, and cross-references that grows richer over time. Dome is the productization of that pattern with one architectural commitment: **the compiler is the load-bearing thing, not any particular interface.** The vault lives on disk as plain markdown. You write into it from whichever surface fits. The compiler keeps the structure coherent regardless of where the writes came from.

The result is what we mean by a *brain companion*: ambient, always accessible, streamlined to talk to, allergic to ungrounded confidence, and patient enough to be useful in six months, in four years, in twenty.

## What Dome is

- **A compiler over a markdown vault.** A background daemon (`dome serve`) watches for changes, fires hooks, runs scheduled maintenance, and reconciles missed events when it restarts (`dome reconcile`). The compiler is what makes the vault self-maintaining.
- **A typed markdown vault.** Raw notes, sources, and clips on one side; a compiled wiki of entities, concepts, sources, and syntheses on the other. Bidirectional wikilinks. Index and log files. Standard Obsidian-compatible markdown — open it in any editor and everything works.
- **A small, portable SDK.** Four concepts in the core — **Vault, Document, Tool, Hook** — and nothing else. The same SDK powers the desktop CLI, embeds in a native mobile or web app, and drives headless workflows. The compiler runs anywhere the SDK runs.
- **A CLI for explicit operations.** `dome lint` proposes hygiene fixes; `dome lint --apply <id>` executes them. `dome query` answers from the vault. `dome export-context` produces a context packet for cross-AI handoff. `dome stats`, `dome doctor`, `dome init`, `dome migrate`. Invokable from any shell, including Claude Code's `Bash`.
- **A prompt library.** Workflows (ingest, query, lint, research, export-context) are markdown prompts loaded by whichever surface needs them. Behavior lives in prose, not code, so it evolves with the user and the model — not with a release cycle.

## Two surface patterns

Dome interacts with the world through two distinct kinds of surfaces, and the design treats them differently.

**Native Dome surfaces** — the iPhone app, desktop app, web app, voice client. Dome ships these. The intake and recall flows are opinionated: deliberate UX for voice capture into `inbox/voice/`, share-sheets into `inbox/clip/`, hotkey quick-capture into `inbox/raw/`, guided recall and prep-mode briefings, structured review of pending wiki proposals. The compiler runs behind them; the surface controls the flow.

**Agentic harnesses** — Claude Code today; Cursor, OpenCode, Codex, future agent harnesses. Dome doesn't ship these; you bring your own. They're general-purpose; they read and write your vault using whatever tools they have natively. **Dome's contract with these harnesses is the compiler boundary**: per-vault `AGENTS.md` teaches the agent your vault's conventions at session start; the watcher catches every native write; hooks fire on each event; `dome reconcile` catches up on whatever the daemon missed; the CLI exposes named structured operations the agent invokes when it wants them. The agent writes whatever, however; Dome keeps the vault coherent on the other side of the write.

Native surfaces optimize for friction (designed flows). Agentic harnesses optimize for openness (any tool, any conversation, any model). Both write the same vault; the compiler delivers consistency over both.

## What Dome is not

- Not a notes app, not a chat product, not a meeting recorder, not a wearable.
- Not a replacement for Obsidian, Notion, or Claude Code — it augments them.
- Not always-on. Capture is intentional and visible.
- Not opinionated about ontology. The wiki's structure emerges from what you actually talk about.
- Not a SaaS your memory is trapped inside. Dome's database is a folder of markdown on your disk.

## Principles

**1. Markdown is the source of truth.** Anything Dome derives can be rebuilt from the markdown alone. No proprietary database, no vendor lock-in. If Dome disappears tomorrow, your vault is fully usable in any markdown editor — and your AI tools can read it directly. By refusing to own the data, Dome earns the right to be the layer that touches it.

**2. The compiler is universal; surface opinion is per-surface.** The same compiler runs over your vault regardless of which surface wrote into it. Native Dome surfaces (mobile, desktop, web, voice) layer opinionated UX on top of the compiler — designed capture flows, designed recall flows, designed review surfaces. Agentic harnesses (Claude Code etc.) bring their own UX; Dome reconciles whatever writes they produce. The compiler boundary — watcher + hooks + reconcile + CLI + `AGENTS.md` — is the explicit contract that lets every surface coexist.

**3. Invariants are enforced two ways, by scope.** *Internally* — within Dome's own dispatcher / hook / tool chain — every write goes through a typed Tool that enforces structural rules: raw is immutable; pages are typed by directory; wikilinks use full paths; index and log are dispatcher-owned. Hooks observe events and call Tools; they never write directly. *Externally* — across the consumer-shell boundary — invariants are reconciled rather than gated. Native writes from any consumer surface get caught by the watcher, replayed by `dome reconcile`, corrected by hooks. The hard guarantee is *eventual consistency by design*, not enforce-at-every-write-call.

**4. Interfaces are interchangeable; the vault is forever.** The agentic harness can be Claude Code today, a Dome-native mobile app in eighteen months, a voice client wired into AirPods, an unknown agent harness in 2030. The vault and the SDK are durable; the UI is not.

**5. The user always wins.** Provenance is mandatory: every claim cites its source. Contradictions are surfaced, never silently overwritten. The wiki records the user's claims, not the AI's interpretation of them. When the AI is uncertain, it says so and asks.

**6. Extensibility lives at the hook boundary.** New behavior — auto-cross-reference, sync to a remote, drop-zone intakes, scheduled lint, plugin integrations — registers as a Hook against an event pattern. The four-concept core never changes. Years of features can land without touching the primitives. This is what keeps Dome stable enough to be a long-term substrate.

## How it works

**Quick-capture from anywhere.** A phone widget, a voice memo, a share-sheet, a terminal hotkey, a file drop into `inbox/`. The capture writes raw markdown; the daemon's watcher fires; the ingest hook compiles raw → wiki updates while you walk.

**Talk to your agent.** Today that's Claude Code, with `AGENTS.md` auto-loaded so the agent arrives oriented to your vault — knowing its conventions, page types, named workflows, and invariants. The agent reads pages, writes updates, proposes cross-references, asks for confirmation. Whichever tools it uses — native filesystem operations or Dome's CLI commands invoked via `Bash` — the compiler catches up: hooks fire on each write; the index updates; the log grows; the vault stays coherent.

**Browse in Obsidian** — or any markdown editor, or the Dome mobile app once it ships. Nothing about the vault is proprietary.

**Tend the garden periodically.** Weekly or monthly, `dome lint` walks the wiki and flags stale claims, orphan pages, missing cross-references, contradictions, schema violations — writing a structured report with stable finding ids. You review and apply via `dome lint --apply <id>`. The garden stays well-shaped.

**Ask, prep, brief, and hand off.** *"What did I decide about hiring last quarter?"* *"What should I bring up with Maya tomorrow?"* *"Produce a context packet for ChatGPT on the platform-ownership question."* The wiki is the durable thing across every AI tool you use; Dome makes them all coherent.

## Audience

We build first for high-context operators — managers, founders, researchers, consultants, technical leaders — who already feel the pain of fragmented context across ten pinned AI threads. Their vaults grow dense fast enough to validate that the compilation pattern works. Their willingness to pay matches the value of the time they recover.

But the constraint that makes Dome work for them — *the compiler does the structural maintenance; the user just talks* — is the same constraint that makes it work for anyone. A student building a thesis bibliography. A writer maintaining character notes across a novel. A new parent tracking what their kid is curious about this month. A retiree organizing the family history. The product is general-purpose by design; the wedge is specific by sequencing.

## Shape over time

**v0.5 — Demo.** A TypeScript SDK on Bun, a small CLI (`dome init`, `dome serve`, `dome reconcile`, `dome lint`, `dome stats`, `dome doctor`, `dome export-context`, `dome migrate`), a prompt library, an MCP server preserved in the codebase as a non-primary surface (future-investment for non-CLI-capable harnesses). Claude Code is the first agentic harness; `AGENTS.md` is the orientation surface; Obsidian browses the vault; git is the history. This phase exists to prove the compiler runs in real use, in real vaults, against real workflows. The author of Dome is its first user.

Notably, this repo's own `docs/` directory is itself a Dome vault — proof that the pattern generalizes beyond personal notes to systems-thinking substrate. Specs, invariants, behavior matrices, gotchas, syntheses about the project all live as Dome pages, maintained the same way a personal vault is.

**v1+ — Product.** Native mobile app: voice-first capture, structured browse, prep mode, inbox review. Native desktop. Voice client. Web app. Optional cloud sync over the markdown vault. Onboarding that meets each user where they are — a new vault, an existing Obsidian vault, a pile of Apple Notes, a stack of Google Docs. Same SDK underneath. Different surfaces above. The opinionated-flow patterns for native surfaces solidify here; the compiler boundary for agentic harnesses remains the contract.

**Long term.** Dome is what people use the way they use their phones: ambient, always there, low-friction. You think out loud; Dome remembers. You ask; Dome answers from your own thinking. The garden grows over years, and grows beautifully, because the gardening is automatic. The cognitive surface of an individual — what they pay attention to, what they decide, what they change their mind about — becomes a durable, exportable, queryable asset that compounds for a lifetime.

## Why this matters

The bottleneck on high-quality knowledge work is not capture. It is *coherence over time*. The hardest part of thinking deeply about anything is remembering what you already thought, finding the thread you dropped six weeks ago, noticing the contradiction between today's idea and last quarter's principle. Existing tools make capture easy and coherence impossible.

If Dome works, the cost of staying coherent across years drops to near zero. The hardest part of being a thoughtful person becomes the easy part — and everything else, better decisions, faster research, sharper writing, more durable relationships, fewer dropped threads, follows.

That is what we are building.
