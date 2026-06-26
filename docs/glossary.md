---
type: glossary
created: 2026-06-10
updated: 2026-06-26
tags:
  - orientation
  - vocabulary
---

# Glossary

One line per term; the linked spec is normative. This page exists because the
four-concept core is small but the working vocabulary on top of it is not. A
term that lives in only one spec is defined there, not here.

## The four core types

- **Vault** — a git-backed markdown directory plus the engine that maintains it. [[wiki/specs/sdk-surface]]
- **Proposal** — a commit range proposed for adoption; the only write path. [[wiki/specs/proposals]]
- **Processor** — code that reads a vault snapshot and returns effects; the only behavior unit. [[wiki/specs/processors]]
- **Effect** — what a processor returns; eleven kinds, closed taxonomy. [[wiki/specs/effects]]

## Engine vocabulary

- **Adoption** — the fixed-point loop that turns a Proposal into trusted state. [[wiki/specs/adoption]]
- **Adopted ref** — `refs/dome/adopted/<branch>`; the cursor for the last fully-compiled commit. Queries read here, never HEAD.
- **Candidate** — the merge of adopted state + Proposal head that the adoption loop iterates on.
- **Closure commit** — the engine commit (with `Dome-*` trailers) that lands accumulated patches when adoption converges.
- **Phase** — when a processor runs: **adoption** (deterministic, inside the loop), **garden** (after adoption), **view** (on command).
- **Garden run** — a single non-signal garden-phase processor invocation: a schedule fire, a queued job, or an answer handler, dispatched against the adopted snapshot outside the adoption loop and routed via `routeGardenRunEffects`. The signal-triggered garden pass differs: it batches many processors' patches before spawning. The shared dispatch+route mechanism is `dispatchGardenRun` (`src/engine/garden/garden-run.ts`).
- **Trigger** — what starts a processor run: signal / path / schedule / answer / command.
- **Signal** — a change event the engine synthesizes from a Proposal's diff (`file.created`, `document.changed`, …). Unqualified, "signal" means this — not the preference signal (see §One word, several meanings).
- **Capability / grant** — what a processor declares it needs vs. what the vault config allows; the intersection is enforced at the broker. [[wiki/specs/capabilities]]
- **Broker** — the single chokepoint every Effect passes before application.
- **Projection** — derived, rebuildable SQLite state (facts, search, diagnostics, questions). Wipe-and-rebuild safe. [[wiki/specs/projection-store]]
- **Run ledger** — one audit row per processor invocation. [[wiki/specs/run-ledger]]
- **Outbox** — the durable queue for external actions; row inserted before the call, idempotency-keyed.
- **Question / decision** — the same thing at two altitudes: a `QuestionEffect` is the mechanism; `dome check` presents the open ones as *decisions* for `dome resolve`.
- **Answer handler** — a garden processor triggered by a durable answer.
- **Quarantine** — where a repeatedly-failing processor sits until recovered.
- **Compiler host** — the tick loop behind `dome serve` / `dome sync`: detect branch drift, construct the Proposal, run adoption.
- **View dispatch** — the shared `dispatchView` core (`src/surface/adapter.ts`) that opens a vault, runs a catalog view, validates it against the first-party View Contract, and routes the three outcomes (open-failed / problem / ok) to a per-protocol `ViewRenderer`. Error rendering is the protocol-uniform seam; `ok` rendering (JSON / HTML / stderr) stays with the caller. The adapter analog of [[#Garden run]]'s `dispatchGardenRun`; CLI / MCP / HTTP all flow through it.

## Content conventions (markdown grammar)

- **Raw** — immutable captured source under `raw/` or `inbox/raw/`; never edited after creation.
- **Capture** — a thought dropped into `inbox/raw/` as one ordinary human commit (`dome capture`, the MCP tool). [[wiki/specs/capture]]
- **Intake bucket** — an `inbox/` subdirectory captures land in before compilation; ephemeral per [[wiki/invariants/INBOX_IS_EPHEMERAL]].
- **Block anchor** — `^id` line identity; move-stable, survives edits. [[wiki/specs/task-lifecycle]]
- **Generated block** (= **owned block**) — a marker-delimited region exactly one processor may regenerate. "Owned" is the same thing seen from the capability side (`owns.path`).
- **Claim line** — `**Key:** value *(as of date)* ^c…`; the stamped-fact grammar. [[wiki/specs/claims]]
- **core.md** — the owner-tendable always-loaded memory page; exactly one automated writer (the preference-promotion answer handler). [[wiki/specs/preferences]]

## Product surfaces

- **Daily note / daily surface** — the per-day page `dome.daily` maintains; three acts: morning edition / live surface / close. [[wiki/specs/daily-surface]]
- **Edition** — the named morning choreography (consolidate → sweep → brief → create-daily). A schedule over existing processors, not a mechanism.
- **Brief** — the model-written morning summary block; degrades to a deterministic fallback when no model is configured.
- **Open loop** — a source-backed *rendering* of unfinished work in a daily surface. Tasks are the source of truth; open loops are the view.
- **Close scaffold** — the deterministic evening block: done candidates, still-open count, story pointer.
- **Sweep** — the nightly meaning-integration pass over recent material. [[wiki/specs/sweep]]
- **Subscription** — a declared external-feed fetch in `dome.sources`: schedule + vault-authored command + output path. [[wiki/specs/sources]]
- **View Contract** — a first-party view's single declaration (`FirstPartyViewEntry` in `src/surface/view-catalog.ts`): command trigger, expected ViewEffect name + version tag (`schemaTag`), the zod **payload** schema (tier 1 — validates the structured data, retiring `data: unknown`), and an optional **view-model** builder (tier 2). The view-layer analog of the sqlite row-codec; adapters validate against it and paint. [[wiki/concepts/surface-view-model]]

## Processor shapes (not primitives)

Warden, agent, and the retired v0.5 words all name *shapes of Processor* —
there is no fifth core type behind any of them:

- **Warden** — a garden processor with `model.invoke` + `question.ask` and no `graph.write`: reads, judges, asks. Model judgment stays transient; durable outcomes arrive only via answered questions. [[wiki/specs/task-lifecycle]]
- **Agent** — a garden processor running a tool-use loop via `ctx.modelInvoke.step`; writes land as one `PatchEffect` inside its grant. [[wiki/specs/autonomous-agents]]
- **Maintenance loop** — descriptive metadata grouping processors by the desired condition they maintain; read by status/check, never a dispatcher. Bundle-scoped loops are declared in `manifest.yaml`; cross-bundle composition loops live in the core registry.
- **Retired: Tool, Hook, Workflow** — v0.5 primitives that dissolved. A "tool" is a processor emitting PatchEffects; a "hook" is a signal-triggered processor; a "workflow" is a garden processor with `model.invoke`. Don't reintroduce them as nouns; see [[wiki/linters/no-retired-symbol-names]].

## One word, several meanings

- **loop** — (1) *maintenance loop*: processor-grouping metadata; (2) *open loop*: an unfinished-work row in a daily surface; (3) the *agent's* internal tool-call loop. Qualify which one you mean.
- **signal** — (1) the engine change event that fires triggers; (2) a *preference signal*: a dated `+`/`-` line in `preferences/signals.md` ([[wiki/specs/preferences]]). Unqualified means the engine event.
- **settle** — three unrelated lifecycles share this verb: (1) a *task* is **settled** when its checkbox reaches `[x]`/`[-]`; (2) the sweep records **settlement** of a material→destination pair via a `sources:` frontmatter link; (3) a maintenance loop's **settlement rule** tells status/check how to decide the loop's goal currently holds.
