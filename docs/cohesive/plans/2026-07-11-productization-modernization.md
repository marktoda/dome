# Productization, modernization, and simplification

**Date:** 2026-07-11
**Status:** P0–P4 completed; continuation sequence defined
**Inputs:** [[cohesive/reviews/2026-07-09-first-principles-product-review]],
[[cohesive/reviews/2026-07-10-incremental-document-compiler-pressure-test]]
**Supersedes as plan of record:** [[wedge]]

## Outcome

Turn the recovered July redesign into a dependable product before adding more
engine concepts. The next release should make Dome feel like one continuous
loop:

```text
capture or author
  -> compile and adopt
  -> recall / Today / attention
  -> owner or agent resolves the next bounded action
  -> semantic garden proposes maintenance
  -> health proves the loop is current
```

The ordering is operational truth first, performance second, onboarding
third, and new intelligence last.

## Recovered baseline

The interrupted working tree was not random residue. It contained four
implemented and documented product slices:

1. **Replaceable agent host.** `AgentRuntime` owns sessions and protocol-
   neutral events. HTTP and the PWA use the session protocol; installed plugin
   views are discoverable through Vault, CLI, MCP, HTTP, and agent tools.
2. **Derived owner attention and agent work.** Questions and proposals remain
   the durable authorities. Bounded owner attention and revision-safe agent
   packets are compiled views, not new queues or workflow stores.
3. **Natural-language lexical recall.** Query analysis and minimum-match
   candidate generation are shared by query and context export, with outcome
   canaries.
4. **One semantic gardening loop.** Consolidate, sweep, patrol, their ledgers,
   queues, and continuation handlers were replaced by deterministic
   opportunity compilation plus proposal-only model work.

The recovery verification on 2026-07-11 established:

- all three TypeScript configurations pass;
- 3,222 tests pass with zero failures;
- repository whitespace and conflict checks pass;
- the docs-vault smoke passes when the external work vault is excluded;
- the full smoke reaches the work vault but fails its health gate with zero
  errors and 23 warnings.

## What is good and should remain stable

### Four concepts and one mutation path

Vault, Proposal, Processor, and Effect remain the sealed core. The redesign
improves the product without creating Workflow, Tool, AgentJob, AttentionRow,
or GardenQueue primitives. Effects still cross one capability-checked apply
path.

### Derived coordination

`compileAttention`, `compileAgentWork`, and `compileGardeningPlan` are deep
modules: their interfaces expose useful decisions while hiding ranking,
settlement, revision checks, and selection policy. Deleting them would spread
that complexity back across CLI, HTTP, MCP, PWA, and processors.

Keep their external seams small. New protocols should adapt these interfaces;
they should not acquire independent ranking or lifecycle rules.

### Markdown and Git remain authoritative

The system now deletes more operational registries than it adds. This is the
right direction: durable answers and proposal decisions record human
authority, while attention, agent work, search, and garden opportunities are
recompiled.

### Views as the extension surface

Runtime-derived view discovery is more coherent than teaching every consumer
about a static catalog. Keep named first-party wrappers only when they add a
materially better human interface; generic callers should use `listViews` and
`runView`.

## Current gaps, in priority order

### P0 — make operational health tell the present truth

**Completed 2026-07-11.** The work vault's grants were refreshed, duplicated
task identities were repaired to a convergent fixed point, 30-day retention
pruned 2,367 succeeded runs and 61,515 capability-use rows, and the compiler
service was restored. Recurring-timeout health now considers only the current
processor generation inside a 24-hour window. Oversized ledgers remain an
informational maintenance finding instead of making an otherwise functioning
compiler unhealthy. The two-vault release smoke passes; content diagnostics
remain visible as a separate garden-quality backlog.

At the start of recovery, the work vault reported:

- a 2 GB run ledger, including 1,127 retained forensic rows;
- 11 duplicate task anchors;
- two missing `proposals.read` grants for the new garden processors;
- nine recurring-timeout findings whose latest samples were recorded between
  July 7 and July 9;
- six informational grant-starvation findings.

This blocks the real release smoke even though code and tests pass. Resolve
the vault state, but also improve Dome so old evidence does not make current
health permanently red.

Deliverables:

1. Refresh the work-vault grants and review deliberate narrowings.
2. Dry-run and apply task-anchor repair, then sync and verify identity
   convergence.
3. Prune and vacuum safe run-ledger rows; quantify the forensic remainder.
4. Redesign recurring failure/timeout health around a recent window and the
   latest processor generation. Historical events remain inspectable but do
   not indefinitely fail readiness.
5. Add an explicit distinction between `healthy now`, `historical risk`, and
   `maintenance recommended` to the doctor schema and smoke gate.

Acceptance:

- `bun run v1:smoke` passes against both dogfood vaults;
- no data is deleted without a dry-run and an inspectable retention rule;
- current failures still fail the gate immediately;
- old timeout forensics remain available through inspection.

### P1 — measure and remove repeated whole-vault work

**Completed 2026-07-11.** One internal `RevisionSource` now supplies revisions
and diffs to compile-range, processor Snapshot construction, and projection
rebuild. It hides bounded process-lifetime revision/tree/blob caches,
in-flight read deduplication, deterministic path ordering, and counters behind
two entry points. It adds no dependency, database, Effect kind, processor
contract, or persistence. Existing 1,000-file lint characterization remains
well below the former timeout boundary, and interface tests prove manifest
and blob reuse plus lazy content I/O.

Do not implement the large Document Compiler plan. Start with the internal
`RevisionSource` proposed by the pressure test:

```ts
type RevisionSource = {
  snapshot(commit: CommitOid): Promise<Snapshot>;
  diff(base: CommitOid, head: CommitOid): Promise<CompileRangeResult>;
};
```

This module should replace the independent tree walking in compile-range,
processor snapshots, and projection rebuild. It may own bounded process-
lifetime caches for immutable tree manifests and blob-text promises. It adds
no public ontology, database, scheduler, Effect kind, or dependency.

Before and after the change, record per-processor:

- invocations and productive Effects;
- tree walks, blob reads, bytes parsed, and cache hits;
- fixed-point iterations and garden sub-Proposals;
- wall time and retained heap.

Then optimize only demonstrated broad offenders. The
`dome.markdown.lint-supersession` processor is the first candidate.
Gardening's pairwise comparison should also be measured at work-vault
cardinality before its target scope grows.

Acceptance:

- clean and incremental outcomes remain byte-equivalent;
- capability-scoped snapshots never enumerate unreadable paths;
- the real-vault benchmark improves without raising timeouts;
- no persistent cache is added unless cold-start cost remains material.

### P2 — make the first-run product one coherent loop

**Completed 2026-07-11.** `bun run product:journey` executes one hermetic
second-user acceptance path through the real compiler host and shipped
bundles: capture, model-backed ingestion, Today resurfacing, natural-language
recall, owner resolution, semantic-garden inspection, and clean doctor. The
fixture uses a scripted command provider and requires no network or secret.
The underlying Vault operations remain separately contract-tested through MCP
and HTTP, while this journey owns the product-level sequence and vocabulary.

The SDK has many surfaces, but public usefulness depends on one successful
journey. Create a release fixture and a second-user script that proves:

1. initialize a vault and choose a model provider;
2. capture a note containing a fact and an action;
3. adopt it and see the action in Today;
4. recall the fact with a natural question;
5. resolve one owner decision or agent-work packet;
6. review one garden proposal;
7. observe a clean status and doctor result.

Use the same fixture across CLI, MCP, and HTTP contract tests. The PWA should
exercise the HTTP journey, not maintain its own behavioral interpretation.

Acceptance:

- a new user reaches value without editing YAML by hand;
- failures identify one recovery command and preserve user content;
- the happy path uses one term for each concept across docs and surfaces;
- the journey is executable in CI without a network model.

### P3 — consolidate product language and navigation

**Completed 2026-07-11.** Primary CLI help and onboarding now organize the
existing product around Today, Recall, Decide, and Maintain without adding a
fifth engine concept. `status` is the cheap router, `check` explains health,
content, and decisions requiring attention, and hidden `doctor` runs fresh
dependency/storage probes for troubleshooting. Stale README claims about MCP
and HTTP being merely planned were removed; wire schemas and command names did
not change.

The engine vocabulary is coherent; the product vocabulary still exposes too
many partially overlapping entry points. Review CLI and protocol surfaces
around four user intents:

- **Today:** what matters now;
- **Recall:** what Dome knows and why;
- **Decide:** what requires owner authority;
- **Maintain:** whether the system and knowledge garden are healthy.

Compatibility aliases may remain hidden, but onboarding and primary help
should teach one route per intent. `status`, `check`, and `doctor` must each
have a non-overlapping promise. Named views should not duplicate generic view
discovery without improving the common case.

Acceptance:

- every primary command has one sentence describing its unique job;
- no onboarding path requires `inspect` or internal processor ids;
- JSON schemas remain stable or carry an explicit version migration;
- CLI, MCP, HTTP, PWA, AGENTS.md, and getting-started use the same nouns.

### P4 — earn the next intelligence layer with evaluation

**Completed 2026-07-11.** A checked-in 30-query corpus now gates lexical
recall across five real work shapes and preserves exact misses as the failure
corpus. The initial baseline is 97.2% relevant recall@5 and 96.7% all-target
success@5; the sole miss is a cross-page synthesis target, while forbidden
noise remains zero. A pure garden outcome compiler reports owner apply/reject
rate, pending load, decision latency, edit size, kind breakdown, and
changed-evidence recurrence directly from durable proposal rows. The work
vault currently has no `dome.agent.garden` decisions, so its owner apply rate
honestly reports `null` and no acceptance threshold has been invented.

Expand the three lexical recall canaries into a 30–50 query benchmark drawn
from real work-vault jobs: people lookup, decision provenance, meeting prep,
project state, and cross-page synthesis. Record retrieval misses before
adding embeddings or reranking.

Likewise, evaluate garden proposals by opportunity precision, owner apply/
reject rate, edit size, and recurrence. A feature should graduate only when
it improves these outcomes without increasing attention load.

Acceptance:

- lexical recall has a versioned offline score and failure corpus;
- garden proposal decisions feed an evaluation report without becoming
  another operational queue;
- embeddings remain a recomputable cache and ship only after measured lexical
  misses justify them.

## Explicit deferrals

Do not add these during P0–P2:

- `documents.db` or normalized compiler artifact tables;
- a generic incremental query/Salsa framework;
- adjacent-revision retained processor output;
- a universal Markdown AST owned by core;
- a new workflow/job/attention primitive;
- embeddings, an LLM reranker, or semantic vector database;
- another protocol-specific behavior layer.

## Continued productization sequence

The next work should harden distribution and the existing seams rather than
add intelligence speculatively:

1. **Git linked-worktree Adapter — completed 2026-07-11.** `isomorphic-git` does not implement Git's
   `commondir` model: linked-worktree HEAD/index state and common refs/objects
   cannot be represented by one `gitdir`. Replace the single `src/git.ts`
   boundary with a complete native-git Adapter for linked contexts (reads and
   writes together), or reject that layout explicitly until parity exists.
   The acceptance fixture must create a real linked worktree, capture and
   adopt on its branch, and prove the main branch/index are unchanged. Do not
   ship a partial fallback or add a subprocess-wrapper dependency. Implemented
   as complete layout routing behind the existing `src/git.ts` Interface:
   valid gitfile contexts use native Git for reads and writes together. A real
   `git worktree add` acceptance fixture proves capture through adoption plus
   branch, worktree, and byte-for-byte index isolation; ordinary `.git/`
   repositories retain the existing Adapter.
2. **Release artifact and migration rehearsal — mechanical rehearsal completed
   2026-07-11.** Produce an installable versioned artifact, test clean install,
   and make service restart/rollback explicit. Rehearse a prior-version upgrade
   only after retaining a real prior artifact and frozen schema fixture. The hermetic
   product journey, product-quality gate, full suite, and two-vault smoke are
   the release checklist. The repository now packs only `src/`, the three
   runtime asset families, `bin/dome`, and `README.md`; the rehearsal installs
   that tarball into a fresh consumer with `bun add --offline`, runs its binary
   and every declared export, scaffolds an external vault from shipped assets,
   and runs local sync/status. It proves two current-schema opens succeed with
   stable HEAD/adopted semantic refs; it does not claim SQLite row preservation
   or migration idempotence. It also does **not** claim a prior-version upgrade:
   no retained prior release artifact exists yet. Publishing, version changes,
   registry access, and the license file remain explicit owner decisions.
3. **Collect garden decisions before tuning.** Run the semantic garden long
   enough to retain at least 20 human decisions, then review apply rate,
   pending load, latency, edit size, and recurrence by opportunity kind.
   Thresholds should follow evidence; no new labeling queue is needed.
   The v2 evidence funnel landed 2026-07-11 without adding persistence or a
   threshold. Verified work-vault retained-history baseline: 59 current
   opportunities; 3 exact `dome.agent.garden` runs (2 succeeded, 1 failed);
   71 `model.invoke` uses; $3.13552980 total recorded cost; 2 effectful runs,
   both without linked proposals; 0 proposals and 0 decisions. Separately,
   the latest successful Jul-11 run observed 23 model invokes,
   $1.36733235 cost, and one retained effect. Adopted retrieval-miss evidence
   was absent (`recordedMisses: null`). These are observations, not targets.
4. **Improve cross-page recall only from recorded misses.** The first corpus
   miss is multi-page synthesis. Add cases from real retrieval-miss records,
   then compare lexical changes with a recomputable semantic candidate layer.
   Embeddings or reranking graduate only if they improve the versioned score
   without adding forbidden-result noise or a new source of truth.
5. **Close real-vault content debt as gardening input.** The work vault is
   operationally healthy but still reports bounded content attention and
   informational diagnostics. Treat those rows as a prioritized quality
   backlog, measure which classes recur, and deepen the owning processor or
   repair command instead of adding another general maintenance mechanism.

Each would enlarge the interface before a proven caller earns the leverage.

## Execution discipline

Each package follows the same loop:

1. capture a real baseline and name the user-visible failure;
2. write or update the normative interface and invariant;
3. implement behind the narrowest existing seam;
4. verify with interface tests and the dogfood vault;
5. delete the superseded path instead of layering compatibility internally;
6. update this plan with measured outcome and the next decision.

The deletion test is mandatory for new modules. If removing a proposed module
would remove complexity rather than push it back into several callers, the
module is probably not earning its interface.

## Recommended next work package

Collect evidence before another intelligence or storage change:

1. Let the nightly daily-rotation selector accumulate real garden outcomes;
   review the v2 funnel after at least 20 human-decided opportunity proposals.
   Do not set an apply-rate, linkage, cost, or opportunity-count threshold in
   advance.
2. Record retrieval misses through the existing collector. The adopted work
   vault currently has no miss file, so semantic retrieval work has no new
   evidence base yet; add corpus cases only when real misses exist.
3. Use the existing work-vault attention diagnostics as the content-debt
   backlog and deepen the processor that owns any recurring class.

Explicit owner decisions remain outside implementation: choose the license,
release version, and registry/public-access policy before publishing; retain
that first release artifact before claiming or rehearsing a prior-version
upgrade. Until those decisions and the evidence samples exist, the next work
is observation and dogfooding, not another primitive, queue, database, model
layer, or hidden threshold.
