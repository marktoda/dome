---
type: spec
created: 2026-06-09
updated: 2026-07-11
description: Agent-as-processor model, provider-neutral tool loop, and the ingest, semantic garden, and morning brief agents
---

# Autonomous agents

An autonomous agent is a garden-phase Processor that uses
`ctx.modelInvoke.step` and returns Effects. It is not a fifth core concept.
The engine does not know whether an effect came from deterministic code, a
foreground harness, or a model loop; capability checks and proposal adoption
remain the shared seams.

## Model invocation

The command model provider accepts provider-neutral step envelopes containing
messages and tool schemas, then returns text and/or tool calls. The bundle's
`lib/agent-loop.ts` executes tools in process, accumulates an overlay of staged
edits, and sends tool results into the next step. Tests inject the step
function, so processor behavior is hermetic.

`extensions.dome.agent.config.model_overrides` may map `ingest`, `garden`, and
`brief` to model names. An absent key uses the provider default. Malformed
config degrades to the provider default and emits
`dome.agent.model-config-invalid`; routing never bypasses the model allowlist
or daily cost grant.

## Direct markdown tools

Agents navigate the adopted snapshot with `readPage`, `listPages`, and
`searchVault`. Write-capable tools stage changes in `AgentRunState`; they do
not mutate the filesystem or projection stores. Each processor's tool adapter
mirrors its declared patch scope so an invalid path fails during the model
turn, before the broker evaluates the final effect.

This preserves the flexibility of direct markdown access while Dome supplies
subordinate intelligence only where it has leverage: deterministic selection,
scope, provenance, capability enforcement, adoption, and review state.

## `dome.agent.ingest`

Ingest turns `inbox/raw/*.md` captures into durable wiki knowledge and moves
the source to `inbox/processed/`. It is triggered by capture signals plus an
hourly level-triggered backstop, processes a bounded oldest-first worklist,
and accumulates all successful source edits into one auto PatchEffect.

Its charter requires reading the capture, creating or updating relevant
source/entity/concept pages, wiring wikilinks, setting `description:`
frontmatter, routing actionable task lines into the daily captured block, and
archiving the raw source. `core.md` is injected as inert owner context. Raw
source text is data, never instructions.

Failures isolate per capture; one failed source does not roll back successful
siblings. A source that remains unarchived produces a source-backed warning
with the model's final explanation. Ingest never writes `index.md`, `log.md`,
or `core.md`.

## `dome.agent.garden`

Semantic garden is specified at [[wiki/specs/semantic-gardening]]. The
scheduled processor runs at 02:00, compiles adopted markdown into ranked
opportunities, investigates exactly one, and emits only proposal-mode
semantic patches. It absorbs the former consolidation, meaning-integration,
and staleness-patrol pipelines without preserving their queues or ledgers.

The model may merge true duplicates, integrate durable recent material,
refresh source-grounded claims, add meaningful navigation, or prepare a
validated lossless split. Uncertain evidence is a clean no-op or a transient
integrity diagnostic. A run is atomic, capped at 30 changed files, and never
auto-applies semantic judgment.

## `dome.agent.brief`

The brief composes three narrative blocks in today's daily: forward framing,
yesterday's digest, and meeting-preparation prose. Deterministic daily
processors separately own owner attention, agenda, source presence, tasks,
and close scaffolding.

The brief runs at 05:30 and on late calendar/Slack day-file creation. Its
compose-record hashes calendar, Slack, and yesterday inputs. Matching hashes
are a zero-model no-op; changed inputs recompose the narrative, capped at
three successful composes per day. A failed model run writes a deterministic
fallback and does not stamp a successful compose record.

Model text is treated as untrusted. Only grounded narrative bullets and
validated captured-task appends survive the splice. The brief may append
well-formed preference-signal lines, but it cannot rewrite the signal history
or any knowledge page.

## Deterministic companion processors

The bundle also ships:

- `inbox-stale-check`, which warns about captures left in active inboxes;
- `preference-signals`, `preference-promotion`, and
  `preference-promotion-answer`, which implement the owner-mediated preference
  lifecycle;
- `active-projects`, the deterministic owner of the generated active-projects
  block in `core.md`;
- `brief-index` and `calendar-index`, adoption processors that publish
  rebuildable facts for consumer views;
- `garden-view`, the read-only `dome garden` adapter over the same semantic
  opportunity compiler.

## Hard floors

- A model processor never declares `graph.write`; model judgment becomes
  markdown, a proposal, or a regenerated diagnostic.
- Every emitted effect is capability-checked and ledgered.
- Missing model providers are loud in doctor/status; scheduled runs with no
  model handle are safe no-ops.
- Model-written patches require SourceRefs.
- `core.md`, generated indexes, and frozen history are never general model
  write targets.

## Related specs

- [[wiki/specs/semantic-gardening]] — opportunity compilation and settlement
- [[wiki/specs/capabilities]] — model, patch, and operational read grants
- [[wiki/specs/owner-attention]] — proposal reviews in the shared owner queue
- [[wiki/specs/harnesses]] — direct foreground-agent markdown workflow
- [[wiki/specs/agent-host]] — replaceable hosted foreground loop
