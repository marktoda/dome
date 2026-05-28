# Dome architecture

This file is the repository-root architecture shim. The active architecture lives in the Dome design substrate, not in a separate duplicated document.

Start here:

- `docs/VISION.md` — product vision, use case, principles, and long-term shape.
- `docs/index.md` — canonical substrate map for specs, invariants, matrices, gotchas, and linters.
- `docs/wiki/specs/sdk-surface.md` — four-concept SDK model: Vault, Proposal, Processor, Effect.
- `docs/wiki/specs/proposals.md` — Git-native write path and internal Proposal construction.
- `docs/wiki/specs/adoption.md` — adopted ref and fixed-point adoption loop.
- `docs/wiki/specs/processor-execution.md` — processor run state machine, timeouts, validation, retries, and quarantine.

Historical context:

- `docs/raw/original-architecture.md` preserves the first architecture seed verbatim. It is useful background, but it is not the normative architecture for v1.

Current high-level contract:

1. Markdown plus git are the canonical knowledge substrate.
2. External writes are Git-native: users and harnesses write markdown and commit normally.
3. Trusted state is `refs/dome/adopted/<branch>`, not HEAD.
4. The engine constructs Proposals internally from branch movement or garden PatchEffects.
5. Processors read immutable snapshots and return Effects.
6. Effects are validated, capability-checked, routed by the engine, and ledgered.
7. `projection.db` is rebuildable derived state; `runs.db` and `outbox.db` are persistent operational audit/recovery state.
