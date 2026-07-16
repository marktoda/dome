---
type: spec
tags:
  - agents
  - questions
  - evidence
created: 2026-07-09
updated: 2026-07-16
description: Derived, evidence-backed agent work over open questions, with revision-safe completion through the durable answer path.
status: shipped
---

# Agent work

Agent work is a protocol-neutral **derived view** over open questions. It is
not a job store, Effect kind, processor phase, workflow primitive, or plugin
category. The deep module is `src/agent-work/`: `compileAgentWork` produces
immutable work packets, `attemptAgentWork` runs one packet through a
replaceable agent adapter, and `drainAgentWork` attempts a bounded ready set.

The interface is intentionally small:

```ts
vault.agentWork({ limit?, questionId? }): Promise<AgentWorkSnapshot>
vault.completeAgentWork({
  questionId, expectedRevision, answer, reason, evidence
}): Promise<CompleteAgentWorkOutcome>
```

Questions remain the durable request. Answers remain the durable settlement.
Deleting the Agent Work module would scatter selection, freshness, evidence,
and safety checks across every agent adapter; deleting an imagined work store
would remove no behavior. This is why compilation earns its seam and another
state machine does not.

## Input and policy

Only open questions whose automation policy is agent-resolvable enter the
snapshot. `agent-safe` is the one canonical policy: a vault-aware agent may
decide using adopted evidence. The old `model-safe` spelling is accepted when
rehydrating existing rows but normalizes to `agent-safe`; model choice is an
adapter concern, not a second authority tier. Missing policy remains
`owner-needed`.

Plugins participate through the existing QuestionEffect contract. They do not
register work providers. A useful agent question declares:

- `metadata.automationPolicy: "agent-safe"`;
- `metadata.resolutionMode: "dispatch"` or `"acknowledge"`;
- allowed options where the domain is closed; and
- SourceRefs to the evidence that makes the decision possible.

## Packet and readiness

Each `dome.agent-work/v1` item carries the question, options, recommendation,
SourceRefs, producer, risk/confidence hints, adopted commit, a revision token,
required evidence paths, and the completion action. Ready work sorts before
non-ready work, then by lower risk, higher confidence, age, and stable id.

Readiness is explicit:

- `ready` — a source-backed dispatch decision;
- `needs-action` — an acknowledgement whose claimed action must happen first;
- `needs-evidence` — a producer supplied no source path; and
- `needs-contract` — a legacy producer omitted resolution semantics.

Non-ready rows stay visible for repair or a more capable foreground harness,
but the generic attempt loop will not pretend to settle them. Operational
processor failures do not enter this view: they remain diagnostics unless a
producer defines a real owner decision with a meaningful continuation.

## Evidence-backed completion

Completion validates against the current packet, not the packet an agent may
have cached:

1. the question is still open and agent-safe;
2. `expectedRevision` matches its current adopted commit and producer run;
3. the answer is non-empty and, when options exist, exactly allowed;
4. the agent provides a non-empty audit reason; and
5. evidence actually inspected covers every required SourceRef path.

The assistant adapter does not trust model-supplied evidence JSON. It builds
completion evidence from citations accumulated by `read_document` and
`run_view` during that turn. MCP and HTTP accept SourceRefs because an
external harness may read Markdown directly; the same validator still checks
coverage and freshness.

Valid completion calls the ordinary durable question answer machinery and
then the ordinary answer-handler dispatch. `answers.db` records
`answered_by = "agent"` plus `{ reason, evidence }`. Its insert is
first-answer-wins, so two agents may investigate concurrently but the later
answer cannot overwrite the winner. No claim lease or abandoned job needs
repair: failures leave the question open and it appears in the next derived
snapshot.

## Agent adapters and transports

`AgentWorkAgent` is the replaceable reasoning seam. It accepts one packet and
returns either an evidence-backed answer or a deferral. Shipped adapters are:

- direct foreground harnesses through `agent_work` and
  `complete_agent_work` MCP tools;
- the companion assistant's `list_agent_work` / `complete_agent_work` tools;
- HTTP `GET /agent-work` and `POST /agent-work/complete`; and
- a hosted/background bounded drain at `POST /agent-work/drain`, using the
  built-in AI SDK adapter or an injected `AgentWorkAgent`.

The engine imports none of these model implementations. The hosted adapter
reads adopted Markdown through Vault, while Claude Code or Codex may use its
native filesystem tools and submit only the completion contract. Both paths
converge at the same evidence and durable-answer seam.

## Non-goals

- No durable retry queue, worker claim, or conversation transcript.
- No general Markdown authoring operation; agent work resolves an existing
  question and its handler emits normal Effects.
- No automatic owner-needed decisions.
- No metadata-only acceptance of a recommendation.
- No plugin-defined executable cards or workflow JSON.

## Related

- [[wiki/specs/owner-attention]]
- [[wiki/specs/agent-host]]
- [[wiki/specs/effects]]
- [[wiki/specs/sdk-surface]]
- [[wiki/specs/mcp-surface]]
- [[wiki/specs/http-surface]]
