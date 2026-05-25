# Dome

> A brain companion that grows with you.

Dome is a substrate for personal knowledge. It turns the thoughts, meetings, research, and ambient context of your work into a living markdown vault — one your AI tools can read, write to, and reason over, while you stay in full control of every file.

It is not another notes app. It is not a place to *store* what you know. It is the layer beneath your existing tools — Claude, ChatGPT, Obsidian, your terminal, your phone — that makes them all talk to the same durable, structured memory of your thinking.

You do not maintain Dome. You tend it. The AI does the gardening; you supply the seeds and walk the rows.

## The idea

The personal knowledge management space is a graveyard of beautiful tools that ask too much of their users. Roam, Notion, Obsidian, Mem, Tana, Capacities — each is excellent at capture, or browsing, or organization, or summarization in isolation. None solve the harder problem: **a memory that compiles itself.**

Andrej Karpathy named the pattern: an LLM Wiki — raw sources stay immutable; the LLM incrementally compiles them into a living wiki of pages, indexes, and cross-references that grows richer over time. Dome is the productization of that pattern, with one constraint: *the user's tools should not change.* The wiki lives on disk as plain markdown. The user keeps using whatever AI they prefer. Dome is the invariant-enforcing layer that makes it all consistent.

The result is what we mean by a *brain companion*: ambient, always accessible, streamlined to talk to, allergic to ungrounded confidence, and patient enough to be useful in six months, in four years, in twenty.

## What Dome is

- **A typed markdown vault.** Raw notes, sources, and clips on one side; a compiled wiki of entities, concepts, sources, and syntheses on the other. Bidirectional wikilinks. Index and log files. Standard Obsidian-compatible markdown — open it in any editor and everything works.
- **A small, hardened tool surface.** A typed SDK of operations (read, write, link, search, route, lint, research) that enforces the vault's invariants at every call site. The wiki cannot bifurcate; raw cannot be rewritten; sensitive content cannot land in the wrong place. The agent owns *what* to do; the SDK owns *whether it is allowed*.
- **A prompt library.** Workflows (ingest, query, lint, research, capture) are markdown prompts loaded by whatever agent is driving. Behavior lives in prose, not code, so it evolves with the user and the model — not with a release cycle.
- **An interface-agnostic surface.** Any MCP-capable agent (Claude Code today; Cursor, Codex, OpenCode, whatever ships next year) becomes Dome-aware by mounting one MCP server. Native mobile, web, and voice clients sit on the same surface later.

## What Dome is not

- Not a notes app, not a chat product, not a meeting recorder, not a wearable.
- Not a replacement for Obsidian, Notion, or Claude Code — it augments them.
- Not always-on. Capture is intentional and visible.
- Not opinionated about ontology. The wiki's structure emerges from what you actually talk about.
- Not a SaaS your memory is trapped inside. Dome's database is a folder of markdown on your disk.

## Principles

**1. Markdown is the source of truth.** Anything Dome derives can be rebuilt from the markdown alone. No proprietary database, no vendor lock-in. If Dome disappears tomorrow, your vault is fully usable in any markdown editor — and your AI tools can read it directly. The format is the moat in reverse: by refusing to own the data, we earn the right to be the layer that touches it.

**2. Invariants live at the tool boundary, not in agent discipline.** Every write goes through a typed tool that enforces structural rules: raw is immutable; pages are typed by directory; wikilinks use full paths; every write is logged with diff; sensitive content routes through review. An agent that wants to violate an invariant cannot — the tool refuses the call. Trust is structural, not behavioral.

**3. Interfaces are interchangeable; the vault is forever.** The agentic harness can be Claude Code today, a Dome-native mobile app in eighteen months, a voice client wired into AirPods, an unknown agent harness in 2030. The vault and the tool surface are durable; the UI is not.

**4. The user always wins.** Sensitive content waits for review. Provenance is mandatory: every claim cites its source. Contradictions are surfaced, never silently overwritten. The wiki records the user's claims, not the AI's interpretation of them. When the AI is uncertain, it says so and asks.

## How it works

**You talk to your agent.** Today, that is Claude Code, or a phone-side voice client once one ships. You say what is on your mind: a thought walking between meetings, a reaction to a paper, a worry about a colleague, an open question on a project. The agent — equipped with Dome's tools and prompts — decides what to do: read the relevant pages, propose updates, route sensitive content to inbox, do background research, append the log, suggest a new cross-reference, ask for confirmation when ambiguous.

**You quick-capture from anywhere.** A single command, a hotkey, a phone widget dumps a raw source and triggers background ingest. The wiki updates while you walk.

**You browse in Obsidian** — or any markdown editor, or the Dome mobile app later. Nothing about the vault is proprietary.

**You tend the garden periodically.** Weekly or monthly, you run lint. The agent walks the wiki and flags stale claims, orphan pages, missing cross-references, contradictions. You approve fixes. The garden stays well-shaped.

**You ask, prep, brief, and hand off.** *"What did I decide about hiring last quarter?"* *"What should I bring up with Maya tomorrow?"* *"Produce a context packet for ChatGPT on the platform-ownership question."* The wiki is the durable thing across every AI tool you use; Dome makes them all coherent.

## Audience

We build first for high-context operators — managers, founders, researchers, consultants, technical leaders — who already feel the pain of fragmented context across ten pinned AI threads. Their vaults grow dense fast enough to validate that the compilation pattern works. Their willingness to pay matches the value of the time they recover.

But the constraint that makes Dome work for them — *the AI does the structural maintenance; the user just talks* — is the same constraint that makes it work for anyone. A student building a thesis bibliography. A writer maintaining character notes across a novel. A new parent tracking what their kid is curious about this month. A retiree organizing the family history. The product is general-purpose by design; the wedge is specific by sequencing.

## Shape over time

**v0.5 — Demo.** A Python SDK, an MCP server, a prompt library, a small CLI. Claude Code is the first official harness; Obsidian is the browser; git is the history. This phase exists to prove the pattern compiles in real use, in real vaults, against real workflows. The author of Dome is its first user.

**v1+ — Product.** Native mobile app: voice-first capture, structured browse, prep mode, inbox review. Native desktop. Voice client. Optional cloud sync over the markdown vault. Onboarding that meets each user where they are — a new vault, an existing Obsidian vault, a pile of Apple Notes, a stack of Google Docs. Same SDK underneath. Different surfaces above.

**Long term.** Dome is what people use the way they use their phones: ambient, always there, low-friction. You think out loud; Dome remembers. You ask; Dome answers from your own thinking. The garden grows over years, and grows beautifully, because the gardening is automatic. The cognitive surface of an individual — what they pay attention to, what they decide, what they change their mind about — becomes a durable, exportable, queryable asset that compounds for a lifetime.

## Why this matters

The bottleneck on high-quality knowledge work is not capture. It is *coherence over time*. The hardest part of thinking deeply about anything is remembering what you already thought, finding the thread you dropped six weeks ago, noticing the contradiction between today's idea and last quarter's principle. Existing tools make capture easy and coherence impossible.

If Dome works, the cost of staying coherent across years drops to near zero. The hardest part of being a thoughtful person becomes the easy part — and everything else, better decisions, faster research, sharper writing, more durable relationships, fewer dropped threads, follows.

That is what we are building.
