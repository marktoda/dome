# Brainstorm — Dome value-proposition reframe (compiler model)

### Current scope

Reframe Dome's value-proposition (the VISION.md story and how the MCP/SDK is positioned) so the structural overlay's promise matches what it actually delivers across multi-surface use. Two driving observations:

- On Claude Code (the user's primary current harness), the agent prefers native `Read`/`Grep`/`Write` over Dome's MCP `readDocument`/`searchIndex`/`writeDocument`. The MCP tools are present but unused; the "gateway" promise is structurally bypassed.
- The user, as their own first customer, is comfortable with eventual consistency and is open to flexible per-surface tool choice ("various different models and approaches for writing the docs"). The structural overlay needs to deliver value that *doesn't* depend on every consumer routing through a single mediating tool surface.

In scope for this brainstorm: the value-prop framing, the use-pattern model (batch capture vs conversational), the MCP surface's role, the multi-surface coherence story.

### Future pressure (not current scope)

- **Multi-surface**: iPhone, desktop, voice client, future agentic harnesses (Cursor, OpenCode, Codex, hosted agent products), web. Each surface has a different friction signature; the design must accommodate them without rewriting the value-prop per shell.
- **Friction minimization**: capture surface (raw thought → vault) and recall surface (query → answer with provenance) should both be near-zero friction at the moment of need.
- **User-as-first-customer**: the user's daily-use signal is load-bearing for whether the framing works.
- **Vault portability over years**: markdown-first; no vendor lock-in; the vault outlives any tool that touches it.

### Non-goals

- Rewriting the SDK. The four-concept core (Vault, Document, Tool, Hook) stays.
- Removing existing capabilities — watcher, reconcile, hooks, workflows, CLI, MCP all stay in code.
- Adopting a different vault format. Markdown stays canonical.
- Designing implementation details. This brainstorm produces a direction; `rewrite-specs` produces the locked design.

## Design options

### Option A: Gateway — Dome IS the toolset

**Summary:** Every consumer-shell action against the vault routes through Dome's Tools (via MCP for chat harnesses, via SDK import for native shells). Invariants live structurally at the tool boundary; an agent that wants to violate one cannot, because the tool refuses the call.

**Substrate changes required:** Strengthen the MCP-as-mount-point claim in `harnesses.md`. Possibly add a `CONSUMER_MUST_ROUTE_THROUGH_TOOLS` invariant. Tighten the system-prompt to instruct agents to prefer MCP tools over native equivalents.

**Locality impact:** Pushes context into the MCP surface — every consumer needs to know about it; the SDK contract becomes "speak MCP or you're not really using Dome."

**Future fit:** Bad for mobile/voice/web (which don't naturally speak MCP). Bad for Claude Code (where the empirical evidence shows the agent doesn't reach for MCP tools when native ones suffice).

**Initial risks:** The promise is empirically not held on Claude Code. The mobile native-shell case explicitly bypasses MCP per `harnesses.md:66`. The rhetoric overpromises what the system actually enforces.

### Option B: Compiler — Dome operates over your markdown

**Summary:** Dome is the layer that runs *over* a markdown vault: watcher catches changes regardless of source, hooks reconcile asynchronously, workflows compile raw inputs into wiki pages on demand. Tools are *one way* to write; native consumer-shell writes are first-class. Invariants are enforced eventually (post-hoc by hooks) rather than at every write call.

**Substrate changes required:** VISION.md rewrites around the compiler framing. `mcp-surface.md` deprioritized — MCP becomes one consumer-shell adapter among many, not the canonical mount. `SENSITIVE_GOES_TO_INBOX` relaxes from "writeDocument refuses sensitive to wiki/" to "post-hoc move via classifier hook." Workflow value-prop sharpens (named structured ops you invoke when you want them, not "every conversation runs in a workflow context"). New gotcha for sensitivity-classification timing window.

**Locality impact:** Locality improves — the dual-path (native vs Tool) concern collapses to a single path (native write triggers reconciliation). The MCP layer's role shrinks dramatically; it's no longer the centerpiece.

**Future fit:**
- **Easy:** native mobile (writes to inbox via SDK or HTTP; daemon compiles); voice client (same shape); new agent harnesses (read AGENTS.md, write markdown, shell out to CLI); friction-minimal capture from anywhere.
- **Hard:** any case where an invariant *must* be enforced before a write completes (e.g., a regulated-data scenario). Not in scope for v0.5.
- **Appears-easy-but-isn't:** none flagged.

**Initial risks:** Eventual consistency means a sensitive doc briefly exists in `wiki/` before the classifier moves it. The daemon (`dome serve`) becomes a single point of failure for the compilation work — if it isn't running, hooks don't fire and drift accumulates.

### Option C: Spine — SDK + ConsumerSurface as the shared layer (collapsed into Option B)

**Summary:** The SDK + `ConsumerSurface` is the load-bearing abstraction; each consumer surface picks its own tool story; the spine guarantees they all operate on the same vault with the same semantics.

**Why collapsed:** Spine is the *architectural* property that lets Compiler work the same on every surface — it's how the value-prop delivers across iPhone/desktop/Claude Code, not a separate value-prop. From the user's perspective, Spine is an implementation detail of where the compiler lives (a portable SDK with adapter-shaped consumer surfaces). Naming it as a distinct value-prop is over-elaboration. Collapsed into Option B as its enabling mechanism.

## Pressure test summary

| Option | Cohesion | Substrate delta | Future fit | Locality | Main risk |
|---|---:|---|---|---|---|
| A: Gateway | Low | Medium | Bad (multi-surface, Claude Code) | High coupling to MCP | The promise isn't empirically delivered; it's bypassed on Claude Code by design and on mobile by spec |
| B: Compiler | High | Large (VISION.md, mcp-surface, harnesses, sensitivity invariant) | Strong | Locality improves (single path) | Daemon-as-SPOF for hook work; eventual-consistency window for sensitivity |
| C: Spine (collapsed) | High (as enabler) | n/a | (same as B) | n/a | n/a |

## Breakage analysis

### Option B: Compiler (the chosen direction)

**Docs that would change:**

- `VISION.md` — rewrite the value-prop to lead with the compiler claim, demote the gateway claim to a per-surface/per-internal concern.
- `wiki/specs/harnesses.md` — recast around AGENTS.md + CLI as the canonical orientation/invocation surfaces; MCP becomes a deferred/optional surface.
- `wiki/specs/mcp-surface.md` — flag as "non-primary / future-investment" surface. Keep the implementation; explicitly document that v0.5 doesn't depend on MCP for value delivery, and that consumer shells (especially Claude Code) are expected to use native tooling. Document the forward-pressure cases (non-CLI-capable harnesses) the MCP would re-earn its keep for.
- `wiki/specs/sdk-surface.md` — clarify that MCP is one of several `ConsumerSurface` adapters, not the canonical mount. The SDK itself remains load-bearing.
- `wiki/specs/cli.md` — already strong; lightly emphasize CLI as the primary explicit-op surface across harnesses.
- `wiki/specs/prompts-and-workflows.md` — workflows are invoked primarily via CLI; MCP-prompts exposure becomes optional/future.
- `wiki/concepts/brain-companion.md` — adjust the "Ambient" bullet to emphasize convention-file orientation + CLI ops over MCP-mounting.

**Existing assumptions that break:**

- "Every Claude Code session in the configured vault directory has Dome's Tools available as MCP tools" (`harnesses.md:42-45`) — still technically true if the user mounts the MCP server, but no longer the canonical path. The canonical path is AGENTS.md + CLI; MCP becomes optional.
- "An agent that wants to violate an invariant cannot — the tool refuses the call" (VISION.md) — retires for consumer shells; survives only for internal Dome flows (workflows → SDK tools → invariants).
- The implicit equation "Dome = MCP" — retires.

**Behavior matrix impact:**

- `wiki/matrices/consumer-surface.md` — the MCP column reweights from "primary" to "optional/future-investment." An AGENTS.md column appears as the orientation surface for chat-shaped harnesses.
- `wiki/matrices/intent-prompt-tools.md` — workflow invocations are CLI-primary; MCP-invocation noted as optional.

**Invariant impact:**

- `MARKDOWN_IS_SOURCE_OF_TRUTH` — *strengthened.* The markdown vault is even more the canonical surface; nothing else is required (no MCP necessary; no app required).
- `HOOKS_CANNOT_BYPASS_TOOLS` — *unchanged in scope, clarified in framing.* It governs Dome's *internal* discipline (hooks observe events and call Tools; never write directly). It says nothing about consumer-shell behavior. The current rhetoric conflates the two; the rewrite separates them.
- `SENSITIVE_GOES_TO_INBOX` — *substantially relaxed.* Was: "writeDocument refuses sensitive content to wiki/." Becomes: "writes to wiki/ are inspected by the sensitivity-classifier hook; sensitive content is moved to inbox/review/ post-hoc." Eventual consistency. This is the most substantive invariant change in the rewrite.
- `EVERY_WRITE_IS_LOGGED` — *clarified.* Tool-mediated writes log automatically via the existing mechanism. Native writes (Claude Code's `Write`, vim, Obsidian, etc.) get logged via the watcher reacting to `vault.out-of-band-edit` events and calling `appendLog`. The watcher's role becomes explicit in this invariant's enforcement story.
- *New (proposed):* `VAULT_RECONCILES_AFTER_NATIVE_WRITE` — every native write to the vault triggers an eventual hook reaction (watcher) or is caught by `dome reconcile` on next startup. The integrity story without the gateway.
- *New (proposed):* `AGENTS_MD_IS_ORIENTATION_SURFACE` — the vault root's AGENTS.md is the canonical agent-orientation surface; auto-generated by `dome init`; the templated sections are refreshed by `dome doctor --repair`; user-prose sections are preserved. Replaces "the MCP `instructions` payload" as the orientation mechanism for chat-shaped harnesses.

**Test guarantee impact:**

- Existing MCP-tool tests still pass (the tools exist in the codebase; they're just not the primary path).
- Tests that assume "agent must use writeDocument" need rewording (now: "agent may use writeDocument; native writes work too").
- New tests needed:
  - AGENTS.md auto-generation by `dome init`; refresh by `dome doctor --repair` preserves user-prose sections.
  - Out-of-band-write end-to-end: native `fs.writeFile` to `wiki/` → watcher fires `vault.out-of-band-edit` → `auto-update-index` hook updates `index.md`; `auto-cross-reference` proposes; `appendLog` logs.
  - Post-hoc sensitivity routing: native write to `wiki/` with sensitive content → sensitivity-classifier hook → `moveDocument` to `inbox/review/`.
  - `dome reconcile` catching multiple types of missed events when the daemon was off.

**Gotchas triggered:**

- *Promoted from workaround to canonical path:* `wiki/gotchas/out-of-band-vault-edits.md` — was "agents may bypass Tools; Dome tolerates it." Becomes: "native writes are first-class; the watcher catches them; this is the canonical path on Claude Code." Document gets upgraded.
- *New:* `daemon-off-while-vault-mutating` — vault drift accumulates while `dome serve` isn't running; `dome reconcile` catches up at next start; user-visible latency. The mitigation: `dome serve` as a launchd/systemd service.
- *New:* `sensitivity-classification-timing` — non-zero window where sensitive content briefly exists in `wiki/` before the classifier moves it; the window is small (hooks fire async with low latency); the user accepted this tradeoff.
- *Stays relevant:* `concurrent-harness-write` — multiple shells editing directly is now the canonical pattern, not the workaround.

**Locality / centralization concerns:**

- Locality improves: the dual-path complexity (write via MCP vs write via native) collapses to a single path.
- AGENTS.md becomes a high-leverage central artifact but lives vault-local (regenerated per-vault by `dome init`). The locality is right — orientation is per-vault, not per-codebase.

**Easy invalid change still possible:**

- A vault that disabled `dome serve` and never ran `dome reconcile` could drift indefinitely. Mitigation: documentation strongly recommends `dome serve` as a daemon; `dome doctor` flags lengthy-since-reconcile state.

## Decision dialog

### Axes walked

- **Axis 1: Where the value lands.** Agent picked **C: Spine** initially; user pushed back ("Maybe help me understand the difference between Spine and Compiler"). Agent re-decided and collapsed Spine into Compiler as its enabling mechanism (Spine is the SDK + ConsumerSurface architectural property; Compiler is the user-facing value-prop). User ratified the re-decided pick: **B: Compiler**. Substrate evidence: `harnesses.md:66` (mobile bypasses MCP by spec), `harnesses.md:71` (ConsumerSurface as the load-bearing abstraction), `harnesses.md:99` ("The SDK is the contract").

- **Axis 2: Primary user motion.** Agent picked **C: Both, unified at the SDK**; user did not push back on the framing. Each surface picks its own motion (capture-and-compile for phone/voice; talk-and-update for Claude Code; explicit ops via CLI); the vault is the unification point. Substrate evidence: `consumer-surface.md` already enumerates per-surface entrypoints; `harnesses.md §"Future-harness pressure"` already names per-surface motions implicitly.

### Sub-decisions

| # | Sub-decision | Tag | Outcome | Notes |
|---|---|---|---|---|
| 1 | Drop or keep MCP read/write/delete/move/searchIndex/wikilinkResolve tools | Pick | **Drop from primary path; keep in codebase, flagged non-primary** | User initially picked "drop"; later refined to "keep around but flag as not used, just in case we have future ideas for something it can be useful for." Conservative preservation of optionality. |
| 2 | Drop or keep MCP workflow exposure (prompts as MCP prompts) | Pick | **Keep in codebase, flagged non-primary** | Same posture as #1. The workflows live in `src/prompts/builtin/`; CLI uses them directly. MCP exposure is preserved as optional. |
| 3 | Mobile v1 architecture | Pick | **M1: capture-only phone, compiler-on-desktop** | Phone writes raw to inbox; vault git-synced or HTTP-synced; desktop `dome serve` does the compiler work. No on-phone LLM. M2 (cloud agent) and M3 (on-phone agent) deferred. |
| 4 | Eventual consistency for sensitivity routing | Confirm | **Ratified** | User explicitly said "I am fully open with the idea of eventual consistency." Relaxes `SENSITIVE_GOES_TO_INBOX` from gateway-shaped to post-hoc reconciliation. |
| 5 | AGENTS.md as orientation surface | Default | Applied | The vault-root AGENTS.md / CLAUDE.md mechanism already exists per `cli.md:30`; this brainstorm makes it the *primary* orientation path (vs MCP `instructions`). |
| 6 | `dome serve` as daemon (vs ad-hoc invocation) | Default | Applied | The current spec already accommodates this (`cli.md:76`); this brainstorm makes the daemon mode the canonical operational shape for desktop. |

### Cross-branch graft check (Phase 4 opening, conv-mode)

- **Hybrid candidate surfaced?** No. The two axes converged independently to mutually reinforcing picks (Compiler + Both-unified). Spine was offered as a competing Axis 1 option but collapsed into Compiler as its enabling mechanism — not a graftable branch, an architectural implementation detail.
- **Cleared?** Yes — proceeded to remaining pressure-test battery.

## Recommendation

**Direction:** **Compiler with preserved-but-flagged MCP.** Dome turns a markdown vault into a self-maintaining substrate via a background daemon (`dome serve` — watcher + reconcile + hooks) + a CLI for explicit operations + per-vault `AGENTS.md` orientation. The SDK is portable across future native shells (mobile, desktop, voice, web) via direct import. The MCP surface stays in the codebase as a non-primary / future-investment surface, explicitly flagged in `mcp-surface.md` as not load-bearing for v0.5 value delivery — preserved against future-harness pressure (non-CLI-capable agents) where it may re-earn its keep.

**Main risk:** The daemon (`dome serve`) becomes a single point of failure for the compilation work — if it isn't running, hooks don't fire on out-of-band writes, the watcher misses events, and vault drift accumulates without user awareness.

**Structural mitigation:** `dome reconcile` is the structural catch-up mechanism — explicitly designed to bring vault state up to date after the daemon was off (already speced at `cli.md:78-96`). `dome doctor` flags structural drift independently (`cli.md:115-148`). The new `dome doctor` check `--time-since-reconcile` (proposed) surfaces drift age. Together: drift detection + structured catch-up *replaces* "agent must use Tools" as the integrity story. Documentation strongly recommends running `dome serve` as a launchd/systemd service for users who want continuous compilation.

**Required substrate before implementation:**

- **Specs:**
  - `docs/VISION.md` — rewrite the value-prop to lead with the compiler framing
  - `wiki/specs/harnesses.md` — recast around AGENTS.md + CLI + SDK direct-import as primary; MCP demoted
  - `wiki/specs/mcp-surface.md` — flag as non-primary / future-investment; document the forward-pressure cases
  - `wiki/specs/sdk-surface.md` — clarify ConsumerSurface as the load-bearing abstraction, MCP as one adapter
  - `wiki/specs/cli.md` — emphasize CLI as the primary explicit-op surface; add `dome doctor --time-since-reconcile` check
  - `wiki/specs/prompts-and-workflows.md` — workflows invoked primarily via CLI; MCP-exposure as optional/future
  - `wiki/concepts/brain-companion.md` — adjust the "Ambient" bullet to lead with AGENTS.md + CLI
- **Matrices:**
  - `wiki/matrices/consumer-surface.md` — MCP column reweights to optional/future; AGENTS.md column added
  - `wiki/matrices/intent-prompt-tools.md` — workflow invocations primarily CLI-shaped
- **Named invariants:**
  - `SENSITIVE_GOES_TO_INBOX` — relax to post-hoc move; rewrite enforcement story
  - `EVERY_WRITE_IS_LOGGED` — clarify the watcher's role for native writes
  - New: `VAULT_RECONCILES_AFTER_NATIVE_WRITE` (proposed)
  - New: `AGENTS_MD_IS_ORIENTATION_SURFACE` (proposed)
- **Tests / checks proposed (not yet implemented):**
  - `dome init` writes AGENTS.md with the templated orientation content + user-prose section delimiters
  - `dome doctor --repair` regenerates the templated sections; user-prose sections preserved
  - Out-of-band-write end-to-end: native `fs.writeFile` → watcher → hooks fire → invariants enforced eventually
  - Post-hoc sensitivity routing: write to `wiki/` with sensitive content → classifier hook → `moveDocument` to `inbox/review/`
  - `dome reconcile` catching multiple missed-event types after the daemon was off
  - `dome doctor --time-since-reconcile` reports drift age
- **Gotchas:**
  - Upgrade `wiki/gotchas/out-of-band-vault-edits.md` from workaround to canonical-path documentation
  - Add `wiki/gotchas/daemon-off-while-vault-mutating.md` (drift accumulation; reconcile-as-mitigation)
  - Add `wiki/gotchas/sensitivity-classification-timing.md` (non-zero window for post-hoc routing)
- **Semantic linters (proposed):** none new in this brainstorm.

### Next

Rewrite the docs to make this direction true. *(`cohesive:rewrite-specs`.)* **Files to edit:** `docs/VISION.md`, `wiki/specs/harnesses.md`, `wiki/specs/mcp-surface.md`, `wiki/specs/sdk-surface.md`, `wiki/specs/cli.md`, `wiki/specs/prompts-and-workflows.md`, `wiki/concepts/brain-companion.md`, `wiki/matrices/consumer-surface.md`, `wiki/matrices/intent-prompt-tools.md`, `wiki/invariants/SENSITIVE_GOES_TO_INBOX.md`, `wiki/invariants/EVERY_WRITE_IS_LOGGED.md`, plus new files: `wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md`, `wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md`, `wiki/gotchas/daemon-off-while-vault-mutating.md`, `wiki/gotchas/sensitivity-classification-timing.md`, and an upgrade to `wiki/gotchas/out-of-band-vault-edits.md`. Slug: `dome-compiler-reframe`. Classification: **Design** (touches normative substrate broadly; no direct implementation work yet).
