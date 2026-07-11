# Evidence-backed agent work

**Date:** 2026-07-09
**Status:** complete
**Normative design:** [[wiki/specs/agent-work]]

## Objective

Turn agent-safe questions into an executable, evidence-backed work loop that
foreground, hosted, and background agents can share without introducing a
second workflow store or coupling the engine to a model provider.

## Implemented

- Added the pure `dome.agent-work/v1` compiler over open question rows.
- Collapsed `model-safe` into a read-compatible alias of canonical
  `agent-safe`.
- Added explicit readiness for dispatch decisions, acknowledgements, missing
  evidence, and missing producer contracts.
- Added revision-safe, all-sources evidence validation and durable agent
  provenance.
- Made durable resolution first-answer-wins across concurrent harnesses.
- Added the provider-neutral one-item attempt and bounded drain loops.
- Added a built-in AI SDK adapter plus an injected-agent seam.
- Exposed the contract through Vault, MCP, HTTP, and companion agent tools.
- Added an additive `answers.db` migration preserving existing answers.

## Deliberate non-goals

- No job table, leases, retry ledger, or scheduler-owned workflow state.
- No automatic execution of acknowledgement questions.
- No engine dependency on AI SDK, MCP, or HTTP.
- No general remote Markdown write operation.

## Completion criteria

- Every ready packet is source-backed, revisioned, and bounded.
- An agent cannot complete a packet without all required evidence paths.
- A stale or owner-needed packet is rejected without mutation.
- Answer handlers run through the existing resolution path.
- Agent identity, reason, and evidence survive projection rebuilds.
- Multiple agents cannot overwrite the first durable answer.
- Failed/deferred attempts naturally remain in the derived queue.
