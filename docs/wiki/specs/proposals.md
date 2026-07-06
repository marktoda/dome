---
type: spec
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
description: "Proposal as the only trusted write path: manual branch-drift and garden-emitted construction, transactional adoption, structural provenance"
---

# Proposals

This spec is normative for Dome's write path. A **Proposal** is the only thing that mutates trusted state. Every write — human, agent, garden processor — becomes a Proposal that the engine then routes through the adoption loop.

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
  | { kind: "manual";  branch: string }                       // compiler-host-derived branch drift
  | { kind: "garden";  processorId: string; runId: string };  // a garden-phase processor emitted a PatchEffect

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
3. **Provenance is structural.** Every adopted commit traces to a Proposal id and a Proposal source. `git log --grep="^Dome-Run:"` yields the engine history; the run ledger ([[wiki/specs/run-ledger]]) joins RunRecords to Proposal ids for cross-source debugging.

This is pinned by [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].

## Construction paths

### Local-eventual mode (the v1 default)

The vault is a single-user single-machine git repo. Writes land in the working tree (vim, Obsidian, Claude Code's native `Write`, the dailies CLI, etc.) and accumulate as commits on the source branch ahead of `refs/dome/adopted/<branch>`.

In v1.0 the local compiler host (`dome serve`, per [[wiki/specs/cli]] §"dome serve") observes the new commits and constructs a Proposal:

```text
proposal = {
  id: "prop_<unix-ms>_<rand>",
  base: refs/dome/adopted/<branch>,
  head: refs/heads/<branch>,
  source: { kind: "manual", branch: <branch> },
}
```

Per docs/v1.md §13.2 ("Claude Code does not need bespoke write tools"), every client — voice clients, Obsidian, Claude Code, mobile, etc. — writes markdown and commits via plain git. The compiler host is the only local runtime that constructs user-write Proposals in v1.0; there is no public submit-style API the client must call. `dome sync` uses the same internal construction path for one-shot catch-up when no long-running host is active. The Proposal then enters the engine's adoption loop ([[wiki/specs/adoption]]).

### Garden-emitted Proposals

A garden-phase processor that emits a `PatchEffect` (per [[wiki/specs/effects]] §"PatchEffect") causes the engine to construct a Proposal from the patch:

```text
engine routes PatchEffect{patch, reason, sourceRefs}
  → broker enforces capability (via enforceCapability in src/engine/core/capability-broker.ts)
  → if allowed: applies patch to the adopted tree via applyPatchToCandidate
                producing a new commit object (no ref yet)
  → constructs Proposal{
      id: "prop_<unix-ms>_<rand>",
      base: refs/dome/adopted/<branch>,
      head: <new commit OID>,
      source: { kind: "garden", processorId, runId },
    }
  → routes Proposal through the same adoption loop
```

**Implementation note (v1.0 — Phase 4a').** The new commit object created
from the patch is an *orphan* — no ref points at it initially. When the
sub-Proposal's adoption succeeds, the adopted ref + the branch ref
(`refs/heads/<branch>`) advance to include the commit in their history,
at which point it's no longer orphan. When the sub-Proposal's adoption
*blocks*, the commit stays unreachable until `git gc` collects it.

This differs from the original spec sketch (which proposed
`refs/heads/dome/garden/<processorId>/<runId>` as a visibility ref
before adoption). The orphan-commit approach is operationally simpler
(no ref-lifecycle management, no stale-branch cleanup) and the
post-adoption visibility through the regular branch history is
sufficient for v1.0. A v1.x polish may reintroduce the dedicated garden
refs if pre-adoption visibility ("what garden work is pending right
now") becomes operationally important — see
[[v1]] for the current automation-first product plan.

**Cascade.** Garden-emitted sub-Proposals fire their own garden phase
when adopted, which may emit more PatchEffects, which spawn more sub-
Proposals. A `DEFAULT_MAX_CASCADE_DEPTH` cap (default 10, in
`src/engine/garden/garden.ts`) prevents pathological recursion; cap-hit emits
a `garden.cascade-cap` DiagnosticEffect (see
[[wiki/gotchas/garden-cascade-cap]]).

**Convergence.** When `applyPatchToCandidate` applies a garden-emitted
PatchEffect whose whole-content `write` targets a file an earlier sub-Proposal
in the same cascade already changed, it does so as a **3-way merge** — not a
whole-file overwrite — whose base is the snapshot the emitting processor read
(`runContext.mergeBase`), with the already-landed candidate blob as `ours` and
the write's content as `theirs`. Two garden processors that edit disjoint
regions of the same file therefore compose: the second does not revert the
first, so the cascade reaches its fixed point instead of livelocking on mutual
reverts. Overlapping edits to the same region resolve to the already-landed
change (`ours`, never reverted) and surface a `garden.patch.merge-conflict`
diagnostic (path + processorId) via the `onMergeConflict` hook; forward progress
is still guaranteed because the conflicted processor re-derives against the
merged state on the next cascade. The adoption-phase apply is unchanged — its
own fixed-point loop (per [[wiki/specs/adoption]] §"The fixed-point adoption
loop") self-heals. See
[[cohesive/brainstorms/2026-06-16-garden-patch-3way-merge]].

A garden processor cannot bypass adoption. The engine is the only entity that constructs a Proposal from a garden effect, and the engine always routes it through the loop. This is the structural fence behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

### Hosted-protected mode (v1.5 — designed-for, not shipped)

In hosted mode (when it ships), Proposals are PRs against `main`. A `PR opened` webhook constructs:

```text
proposal = {
  id: <PR number>,
  base: refs/heads/main (the adopted trunk in hosted mode),
  head: PR's head commit,
  source: { kind: "manual", branch: <PR head branch> },
}
```

The engine's adoption loop runs in CI; engine commits land on the PR branch; the PR merges into `main` on a clean fixed point. Local-eventual and hosted-protected are conceptually the same loop with different cursors. The Proposal abstraction is the seam that makes this true. See [[wiki/specs/adoption]] §"Hosted-protected mode".

## Submission API

In v1.0 there is no public submission API. Proposals are constructed exclusively by engine-internal code:

- **The local compiler host** (`dome serve`, per [[wiki/specs/cli]] §"dome serve") observes a new commit on `refs/heads/<branch>`, sees it diverges from `refs/dome/adopted/<branch>`, and synthesizes a `manual`-source Proposal via the internal `makeManualProposal` helper in `src/core/proposal.ts`.
- **The engine itself** synthesizes a `garden`-source Proposal when a garden-phase processor emits a `PatchEffect` (per §"Garden-emitted Proposals" above).

The internal helper signature:

```ts
// src/core/proposal.ts (NOT re-exported from src/index.ts)
function makeManualProposal(opts: {
  readonly id?: string;          // defaults to a fresh makeProposalId()
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly branch: string;
  readonly metadata?: ProposalMetadata;
}): Proposal;
```

The engine's `adopt()` call returns:

```ts
interface AdoptionResult {
  readonly proposalId: string;
  readonly adopted: boolean;
  readonly adoptedRef: CommitOid;          // the new adopted commit, or the previous one when blocked
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly closureCommitOid: CommitOid | null;  // null when the loop reached fixed point without engine writes
  readonly iterations: number;
}
```

Per docs/v1.md §13.2, "Claude Code does not need bespoke write tools." A client that can write markdown and commit via plain git can participate; the compiler host handles the rest. There is no `vault.tools.writeDocument(...)`, no `vault.dispatchEvents(...)` from outside the engine, no privileged-writer escape hatch. Internal core code (the engine itself, projection rebuilder, init scaffolder) reaches direct git/sqlite primitives through engine-internal modules that are not re-exported from `@dome/sdk`.

This is the structural fence behind [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].

## Reading a Proposal (the engine's view)

When the engine receives a Proposal, it reads:

- The commit range `base..head` to compute changed paths and synthesize signals (per [[wiki/specs/processors]] §"Triggers and signals").
- The tree at `head` as the candidate snapshot the adoption-phase processors operate on.
- The `source.kind` as input to capability enforcement — the broker may grant different effect powers to `manual` vs `garden` Proposals per the vault's policy.

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

## Trust ladder

The trust ladder is how the gardener earns (and loses) autonomy **through the
review loop itself** — no new engine primitive, no self-granted capability.
`dome.health.trust-review` (weekly, Monday 05:24, deterministic; two minutes
after the report card whose trust section shows the same evidence) reads the
durable pending-proposals store (`proposals.read`), the run ledger
(`run.read`), and `.dome/config.yaml`, and emits ordinary effects:

**Promotion.** A proposal producer is promoted from propose-only to
auto-apply when ALL of the following hold over the trailing **28 days**:

- its effective vault grant is propose-only for the paths it proposes
  (granted-side check via the engine's own config parser —
  `parseCapabilityPolicy` — never a parallel grant reader);
- **≥ 8** of its proposals were decided (applied or rejected, bucketed by
  `decidedAt`);
- its accept rate (`applied / decided`) is **≥ 0.75**;
- no trust-review promotion proposal for it is still pending review;
- no promotion for it was **rejected within the last 28 days** (derived from
  the rejected row's `decidedAt` — the store is the state, there is no
  separate cool-down ledger).

The promotion itself is a **config diff as a proposal**: one `mode:
"propose"` PatchEffect whose single change rewrites `.dome/config.yaml` via a
comment-preserving yaml Document edit (the `dome init` ensure-path
precedent), setting `extensions.<bundle>.processors.<id>.grant` to the
producer's current effective grant record **plus** `patch.auto` over the
paths it currently proposes. Because a per-processor grant *replaces* the
bundle grant, the edit carries the other grants over rather than stripping
them, and it materializes the `grants: standard` preset into explicit blocks
first when needed (an explicit `processors:` block opts the extension out of
the preset). The edited body is structurally self-checked — it must re-parse
through `parseCapabilityPolicy` and actually grant the promotion — before it
is ever proposed. The owner reviews with `dome proposals` / `dome apply`
like any other proposal; the `reason` carries the evidence (e.g.
`trust-review: promote dome.agent.consolidate to auto-apply — 19/20
proposals applied over 28d`).

Two structural fences keep this honest: the effect is always `mode:
"propose"`, and trust-review's own grant holds `patch.propose` on
`.dome/config.yaml` **only** — the gardener cannot auto-apply its own
autonomy change even if it emitted the wrong mode. A producer whose proposals
touch `.dome/config.yaml` is never promoted (auto-granting config writes
would be an unreviewed privilege escalation), and trust-review never promotes
itself.

**Demotion / dormancy.** A processor that accrued model cost > $0 over the
trailing **21 days** with zero productive effects (no `succeeded` run that
emitted an effect) is flagged with an **owner-needed question** (stable
idempotency key `dome.health.trust-review:dormant:<processorId>`). This is a
question rather than a config diff because per-processor disable is not
expressible in `.dome/config.yaml` — `extensions.<bundle>.processors.<id>`
accepts only `grant`/`grants` (`PROCESSOR_KEYS` in
`src/engine/core/capability-policy.ts`); disabling means flipping the whole
bundle's `enabled` or narrowing its grant, which stays an owner decision.

**Evidence surface.** The weekly report card ([[wiki/specs/daily-surface]]
§"Report card") renders a trust-ladder section — per proposal-producing
processor: autonomy (auto / propose / unknown), decided/applied counts, and
accept rate over the card's window — so the owner sees the same evidence the
ladder acts on.

Idempotence: an open promotion proposal suppresses re-emission, the
pending-proposals dedupe key absorbs byte-identical re-emission, rejected
promotions stay suppressed for 28 days, and dormancy questions dedupe on
their idempotency key. Re-running with unchanged inputs emits nothing new.

## Related

- [[wiki/specs/adoption]] — the loop that consumes Proposals
- [[wiki/specs/processors]] — what runs inside the loop
- [[wiki/specs/effects]] — what processors emit
- [[wiki/specs/capabilities]] — what limits a Proposal's effect reach
- [[wiki/specs/run-ledger]] — joining ledger rows on Proposal id
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — the structural fence
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — Proposal-to-state translation chokepoint
