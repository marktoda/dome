---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Proposals

This spec is normative for Dome's write path. A **Proposal** is the only thing that mutates trusted state. Every write — human, agent, garden processor, scheduled job — becomes a Proposal that the engine then routes through the adoption loop.

## The Proposal type

```ts
interface Proposal {
  readonly id: string;                  // local: "prop_<unix-ms>_<6-char-rand>"; hosted: PR number as string
  readonly base: CommitOid;             // refs/dome/adopted/<branch> at construction time
  readonly head: CommitOid;             // tip of the change to be adopted
  readonly source: ProposalSource;      // discriminated below
  readonly metadata?: ProposalMetadata; // optional; carries source-specific context
}

type ProposalSource =
  | { kind: "client";    clientId: string }                  // mobile, desktop, voice, native shell
  | { kind: "agent";     harness: string; sessionId?: string }  // claude-code, cursor, future agents
  | { kind: "garden";    processorId: string; runId: string }   // a garden-phase processor emitted a PatchEffect
  | { kind: "manual";    branch: string }                       // user pushed a branch directly
  | { kind: "import";    importerId: string };                  // bulk import / migration tool

interface ProposalMetadata {
  readonly title?: string;       // human-readable; the originating commit subject when single-commit
  readonly authoredAt?: string;  // ISO-8601 of the originating event (capture time, agent turn, etc.)
  readonly reason?: string;      // optional natural-language reason for the proposal
}
```

`base` and `head` together define the commit range the engine adopts. The range may be a single commit (`base..head` is one commit) or many.

## Why Proposals (not direct writes)

Three properties fall out of routing every write through a Proposal:

1. **One write path.** Humans, agents, garden processors, and intake hooks all produce Proposals. The engine doesn't need to distinguish "trusted internal write" from "untrusted external write" at the application boundary — every write goes through the same loop with the same diagnostic and capability checks.
2. **Adoption is a transaction.** A Proposal either adopts cleanly (the loop reaches a fixed point and the adopted ref advances) or it blocks atomically (diagnostics surface; ref stays where it was). There is no partially-adopted state.
3. **Provenance is structural.** Every adopted commit traces to a Proposal id and a Proposal source. `git log --grep="Dome-Proposal:"` yields the engine history; the run ledger ([[wiki/specs/run-ledger]]) joins on Proposal id for cross-source debugging.

This is pinned by [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].

## Construction paths

### Local-eventual mode (the v1 default)

The vault is a single-user single-machine git repo. Writes land in the working tree (vim, Obsidian, Claude Code's native `Write`, the dailies CLI, etc.) and accumulate as commits on the source branch ahead of `refs/dome/adopted/<branch>`.

`dome submit` (the user-facing entrypoint) constructs a Proposal:

```text
proposal = {
  id: "prop_<unix-ms>_<rand>",
  base: refs/dome/adopted/<branch>,
  head: HEAD,
  source: { kind: <inferred from environment>, ... },
}
```

Source inference: if `$DOME_HARNESS` is set, source kind is `"agent"`. If `dome submit` is invoked from a known native-shell harness (mobile sync push, voice client push), source kind is `"client"`. Otherwise, source kind is `"manual"`. The CLI accepts `--source-kind=<k>` to override.

The Proposal then enters the engine's adoption loop ([[wiki/specs/adoption]]).

### Garden-emitted Proposals

A garden-phase processor that emits a `PatchEffect` (per [[wiki/specs/effects]] §"PatchEffect") causes the engine to construct a Proposal from the patch:

```text
engine routes PatchEffect{patch, reason, sourceRefs}
  → applies patch to a fresh branch refs/heads/dome/garden/<processorId>/<runId>
  → constructs Proposal{
      id: "prop_<unix-ms>_<rand>",
      base: refs/dome/adopted/<branch>,
      head: <new branch tip>,
      source: { kind: "garden", processorId, runId },
    }
  → routes Proposal through the same adoption loop
```

A garden processor cannot bypass adoption. The engine is the only entity that constructs a Proposal from a garden effect, and the engine always routes it through the loop. This is the structural fence behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

### Hosted-protected mode (v1.5 — designed-for, not shipped)

In hosted mode (when it ships), Proposals are PRs against `main`. A `PR opened` webhook constructs:

```text
proposal = {
  id: <PR number>,
  base: refs/heads/main (the adopted trunk in hosted mode),
  head: PR's head commit,
  source: { kind: "client" | "agent", ... resolved from PR author identity },
}
```

The engine's adoption loop runs in CI; engine commits land on the PR branch; the PR merges into `main` on a clean fixed point. Local-eventual and hosted-protected are conceptually the same loop with different cursors. The Proposal abstraction is the seam that makes this true. See [[wiki/specs/adoption]] §"Hosted-protected mode".

## Submission API

The single SDK entry point for constructing and submitting a Proposal:

```ts
// from "@dome/sdk"
function submitProposal(
  vault: Vault,
  input?: {
    head?: CommitOid;          // defaults to current HEAD
    source?: ProposalSource;   // defaults to inferred per §"Local-eventual mode"
    metadata?: ProposalMetadata;
  }
): Promise<Result<AdoptionResult, ToolError>>;

interface AdoptionResult {
  readonly proposalId: string;
  readonly adopted: boolean;
  readonly adoptedRef: CommitOid;          // the new adopted commit, or the previous one when blocked
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly closureCommitOid: CommitOid | null;  // null when the loop reached fixed point without engine writes
  readonly iterations: number;
}
```

`submitProposal` is the only way for SDK-embedding code to write. There is no `vault.tools.writeDocument(...)`, no `vault.dispatchEvents(...)` from outside the engine, no privileged-writer escape hatch. Internal core code (the engine itself, projection rebuilder, init scaffolder) reaches direct git/sqlite primitives through engine-internal modules that are not re-exported from `@dome/sdk`.

This is the structural fence behind [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].

## Reading a Proposal (the engine's view)

When the engine receives a Proposal, it reads:

- The commit range `base..head` to compute changed paths and synthesize signals (per [[wiki/specs/processors]] §"Triggers and signals").
- The tree at `head` as the candidate snapshot the adoption-phase processors operate on.
- The `source.kind` as input to capability enforcement — the broker may grant different effect powers to `client` vs `garden` vs `manual` Proposals per the vault's policy.

## Why the local-eventual Proposal id is synthesized (not the commit OID)

The Proposal id is distinct from `head` because:

- A single Proposal may be adopted in multiple iterations of the fixed-point loop, each producing an engine closure commit. The Proposal id stays stable across iterations.
- The id is the run-ledger join key. Run ledger rows reference the Proposal id; without it, joining "what runs were caused by this submission" would require chain-of-commit-trailer walking.
- In hosted mode, the id is the PR number — a stable identifier across PR force-pushes (which change `head` but not the PR identity).

## Lifecycle states

A Proposal moves through:

```text
constructed
  → enqueued        (engine accepted; waiting for adoption-loop slot)
  → adopting        (fixed-point loop running)
  → adopted         (terminal — adopted ref advanced; runs ledgered)
  | blocked         (terminal — diagnostics emitted; adopted ref unchanged; user must resolve)
  | failed          (terminal — engine error during the loop; adopted ref unchanged)
```

The engine emits `engine.proposal.<state>` events on every transition. The run ledger ([[wiki/specs/run-ledger]]) records the full state history with timestamps.

## What a Proposal cannot do

- **Skip adoption.** No bypass; no "trusted" path for SDK-internal callers.
- **Carry side effects.** A Proposal is a commit range. External side effects (network calls, notifications, calendar writes) require an `ExternalActionEffect` emitted by a processor *during* adoption; the outbox ([[wiki/specs/projection-store]] §"Outbox") records the attempt.
- **Mutate state outside `<vault>/`.** Proposals are git commits; they cannot touch arbitrary filesystem paths.
- **Reach past the capability broker.** Every effect emitted during the Proposal's adoption passes capability enforcement ([[wiki/specs/capabilities]]).

## Related

- [[wiki/specs/adoption]] — the loop that consumes Proposals
- [[wiki/specs/processors]] — what runs inside the loop
- [[wiki/specs/effects]] — what processors emit
- [[wiki/specs/capabilities]] — what limits a Proposal's effect reach
- [[wiki/specs/run-ledger]] — joining ledger rows on Proposal id
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — the structural fence
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — Proposal-to-state translation chokepoint
