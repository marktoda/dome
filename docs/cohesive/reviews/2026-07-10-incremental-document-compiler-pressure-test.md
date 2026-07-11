# Incremental document compiler pressure test

**Date:** 2026-07-10
**Scope:** simplicity, repository fit, dependency research, and execution
sequencing for
[[cohesive/plans/2026-07-10-incremental-document-compiler]]
**Verdict:** preserve the direction; cut the first implementation to one
internal module and zero new dependencies

## Executive conclusion

The original plan correctly identifies Git blob identity, repeated whole-vault
work, and clean-rebuild equivalence as the foundations of a scalable Dome.
It is too large as an execution plan.

It currently combines four projects:

1. shared Git revision and blob reads;
2. shared markdown parsing;
3. incremental processor scheduling and retained outputs; and
4. cross-document relationship indices.

Only the first project is proven enough to build immediately. The second
should begin with one or two measured, duplicated parsers. The third changes
the adoption/projection state machine and needs a separate design. The fourth
should be added one relationship at a time when a remaining whole-vault scan
proves it necessary.

The revised first module is:

```ts
type RevisionSource = {
  snapshot(commit: CommitOid): Promise<Snapshot>;
  diff(base: CommitOid, head: CommitOid): Promise<CompileRangeResult>;
};
```

It owns a bounded process-lifetime cache of immutable Git tree manifests and
blob-text Promises. It replaces three independent tree walkers without adding
a database, parser ontology, scheduler, processor phase, Effect kind, plugin
contract, or package dependency.

The rule for the first implementation is:

> Unify immutable source access first. Measure. Cache only a parser whose
> repeated cost is then visible. Persist nothing until cold starts are a
> measured problem.

## Review method

Three independent reviews examined the proposal:

- a simplicity review attacked YAGNI and searched for the smallest useful
  interface;
- a repository-fit review traced adoption, projection cleanup, rebuild,
  capability scoping, bundle ownership, and live runs;
- a dependency review checked mature Bun/TypeScript libraries for Markdown,
  Git walking, incremental computation, caching, serialization, and indexing.

The reviews converged on the same first step and independently rejected a
generic incremental-query engine.

## What survives the pressure test

These decisions remain sound:

- Git blob OIDs are the correct identity for content-pure reuse.
- Git tree OIDs are the correct identity for revision/subtree reuse.
- Incremental and clean compilation must have a canonical equivalence oracle.
- Raw source remains in Git; derived cache state is always disposable.
- Processors continue producing fresh Effects with revision-bound SourceRefs.
- Capability filtering happens before document enumeration or resolution.
- A generic Salsa/Skyframe clone is unsafe while processors can read raw
  snapshots, configuration, clocks, operational stores, and model providers
  outside a tracked query graph.
- Whole-file parsing is sufficient; inside-file incremental parsing is not the
  current problem.

## What the original plan got too ambitious

### 1. It centralized extension-owned grammars

Tasks, claims, and search sections are not generic Markdown syntax:

- task behavior belongs to `dome.daily`;
- claim behavior belongs to `dome.claims`;
- search sectioning and title/category fallback belong to `dome.search`;
- semantic gardening belongs to `dome.agent`.

Those extractors live in independently shippable bundles. Bundle code imports
the core; the core must not import bundle implementations. Moving every
extractor into `src/documents` would either reverse that seam or create another
grammar authority by copying the code.

The repository also deliberately preserves two incompatible fence dialects in
`src/core/markdown-scan.ts`. A universal document artifact would need to
encode both without pretending they are one syntax.

Core may own syntax that is demonstrably shared and path-independent, such as
raw frontmatter boundaries, headings/ranges, generic fence spans, line starts,
and the wikilink grammar once its currently duplicated implementations are
characterized as equivalent. Extension policy stays in the extension.

### 2. The proposed artifact key was not universally pure

`(blobOid, compilerVersion)` is correct only for content-derived values.
Several proposed artifact fields are not:

- fallback title and category can depend on the path;
- relative/bare wikilink resolution depends on the revision's path set;
- ambiguity depends on the effective read grant;
- lint policy may depend on path, page-type configuration, or extension
  configuration;
- SourceRefs depend on path and commit.

The safe split is:

```text
blob-pure: bytes, line/fence/heading spans, raw frontmatter parse,
           raw wikilink matches

revision/path/grant-bound: category, title fallback, resolution, backlinks,
                           lint policy, SourceRefs, Effects
```

### 3. Persistence was proposed before cold-start cost was measured

The vault's source is roughly 7.65 MB. A `documents.db` with schema versions,
six normalized feature tables, WAL lifecycle, integrity checks, garbage
collection, last-seen tracking, and concurrency rules is a substantial new
operational subsystem.

The live 3.4 GB resident process is real evidence, but it does not attribute
memory to Markdown parsing. A persistent artifact database could make memory
or write amplification worse while optimizing the wrong cause.

Begin with a bounded host-lifetime cache. If profiling shows cold restarts or
projection rebuilds are materially expensive after that change, persistence
is earned. Its first shape should be one JSON artifact row per
`(blob_oid, extractor_id, extractor_version)`, not six normalized tables.
Normalize only a relationship that needs indexed lookup.

### 4. Feature hashes lacked a safe dispatch contract

Feature hashes provide useful early cutoff only when Dome knows which
processor depends on which feature. The current trigger contract does not
declare `task_hash`, `claim_hash`, or `search_hash` dependencies.

Computing hashes without a dependency contract may help a processor return
early, but it cannot safely prevent invocation. Adding a feature-to-processor
registry would be another plugin/interface design and is not justified in the
first slice.

### 5. Adjacent deltas are a new projection state machine

The adoption buffer is currently an ordered operation log, not a materialized
map whose entries share one replacement key. Projection kinds settle
differently:

- page-subject facts clear by processor and inspected path, while task/entity
  fact lifecycle is explicitly different;
- diagnostics identify processor, code, proposal, and subject hash;
- questions use idempotency keys plus durable answers;
- search replaces path or `(path, section)` rows;
- diagnostics are recorded at different times from buffered facts/search/
  questions.

Therefore “retain earlier output unless a later processor/path run replaces
it” is not a generic operation yet. Adjacent-revision scheduling may still be
valuable, but it requires explicit canonical output identities and
clean-vs-incremental differential tests. Treat it as a separate design after
source reuse lands.

### 6. Several global indices were speculative

Backlinks are already supported by a real repeated workload. Task-anchor,
claim-key, and semantic-token indices may also become useful, but building all
of them together creates a central schema coupled to every first-party
grammar.

Add one index only when both are true:

1. profiling identifies a remaining O(vault) operation as material; and
2. at least two callers justify a shared interface, or one deep module can
   hide a complex domain rule behind a narrow interface.

## Current repository evidence

### Existing optimization to preserve

`makeSnapshot` already builds one lazy `path -> blob OID` map for a revision,
shares raw-file Promises across processors in that phase, and reads blobs
directly by OID. The associated 1,000-file performance characterization was
added specifically after whole-vault lint timeouts.

This means “cache Git blobs” alone is not a new design. The remaining obvious
duplication is that revision information is still constructed independently:

- `compileRange` walks base and head trees;
- `makeSnapshot` walks the candidate tree again;
- projection rebuild has its own tree walker and all-files signal synthesis.

One `RevisionSource` should own these operations and reuse immutable manifests
across all three callers.

### Live performance is concentrated, not uniform

Recent local extractors often complete in milliseconds. The most obvious
deterministic outlier is `dome.markdown.lint-supersession`, which intentionally
reads and parses all readable Markdown whenever relevant paths change.
Repeated broad processor dispatch and garden sub-Proposals are better proven
than a universal parser bottleneck.

Instrumentation must separate:

- current runs from historical timeout rows;
- Git tree/blob reads from parser CPU;
- bytes parsed from lightweight artifact/index reads;
- proposal fixed-point iterations from garden sub-Proposal count;
- retained heap by module, not only process RSS;
- processor invocations from productive Effects.

## Simplified deep module

### External seam

`RevisionSource` is internal engine/runtime infrastructure:

```ts
type RevisionSource = {
  snapshot(commit: CommitOid): Promise<Snapshot>;
  diff(base: CommitOid, head: CommitOid): Promise<CompileRangeResult>;
};
```

`snapshot` returns today's immutable Snapshot interface. `diff` returns
today's compile-range result. Callers learn no cache keys, eviction rules,
tree-walking algorithms, persistence formats, or parser types.

The module hides:

- commit -> tree resolution;
- a bounded `TreeOid -> sorted path/blob manifest` cache;
- a bounded `BlobOid -> Promise<string | null>` cache;
- paired manifest diffing;
- deterministic path/signal ordering;
- in-flight read deduplication;
- byte/count accounting and eviction;
- dogfood-vault prefix handling through `src/git.ts`.

This passes the deletion test: removing it would restore three tree walkers,
multiple caches, duplicate ordering rules, and repeated object reads.

Dependencies are local-substitutable: real temporary Git repositories exercise
the module in tests. There is no reason to publish a Git storage port.

### Cache shape

Use small private insertion-ordered Maps initially:

```text
revision manifests: bounded by count, initially 4
blob text: bounded by total UTF-8 bytes, initially 2x current vault bytes
in-flight reads: the cached Promise itself
```

Eviction removes the oldest unpinned entry. Active snapshots pin their
manifest and blobs for the duration of a phase. These rules are internal and
may later be replaced without changing the interface.

Do not add access timestamps or background garbage collection. The whole cache
dies with the host process.

### Optional later document seam

If profiling proves repeated parsing remains material after `RevisionSource`,
add the smallest processor-facing widening:

```ts
type DocumentSource = {
  readonly path: string;
  readonly blob: BlobOid;
  text(): Promise<string>;
};
```

Capability filtering occurs before a `DocumentSource` is returned. Bundle-local
extractors may memoize pure results by blob OID. A generic runtime extraction
memo is considered only after two bundle-owned extractors need the same cache
lifecycle.

Do not begin with `resolveWikilink`, `backlinks`, `tasksByAnchor`, or a universal
`CompiledDocument`. Let measured callers earn those methods.

## Library review

### Adopt what is already present

| Need | Decision | Reason |
| --- | --- | --- |
| Git objects and trees | Keep `isomorphic-git` behind `src/git.ts` | Already the sole Git implementation; tree/blob OIDs provide the required identities |
| SQLite, if persistence is earned | Keep `bun:sqlite` through shared store helpers | Already supplies transactions, WAL, prepared statements, JSON and FTS; another database duplicates a seam |
| Frontmatter | Preserve `gray-matter` behavior initially | Current coercion and malformed-input behavior are already characterized product semantics |
| YAML validation/config | Keep `yaml` | Already direct, active, and sufficient |
| Hashing | Keep existing SHA-256 helpers | Volumes are small; collision and compatibility reasoning stay simple |
| Small LRU | Private bounded `Map` | Four revisions do not justify a package or public seam |

Phase one should make no `package.json` change.

### Parser candidates

`mdast-util-from-markdown` plus micromark is the only mature parser candidate
worth a later spike. It is ESM/MIT, actively maintained, and provides source
positions. It should not be adopted by default because:

- mdast is not a lossless serializer;
- Obsidian wikilinks are not core CommonMark;
- Dome's task, claim, generated-block, and fence behavior is custom;
- replacing parsing and adding caching simultaneously makes regressions hard
  to attribute.

If explored, use `mdast-util-from-markdown` directly rather than the full
unified/remark transform pipeline, retain raw source, and compare its positions
and extracted values against the entire current corpus. Adopt it only if the
spike deletes substantial scanner code without changing canonical output.

`@lezer/markdown` is designed for editor-keystroke incremental parsing. Dome
compiles immutable Git blobs, so its complexity solves the wrong problem.

### Libraries explicitly rejected for now

- TypeScript Salsa-like packages: immature and unable to register Dome's
  non-document inputs safely.
- `lru-cache`/`quick-lru`: mature or small, but unnecessary for four revision
  entries and Dome-specific byte budgets.
- MessagePack/CBOR/JSC serialization: opaque version coupling without a proven
  persistence need.
- LMDB, LevelDB, `better-sqlite3`, Drizzle, Kysely: duplicate Bun/SQLite
  infrastructure.
- MiniSearch or another search index: FTS5 already owns search projection.
- native Git/libgit2: duplicates the existing Git seam and complicates Bun
  portability.

Relevant primary references:

- [isomorphic-git walk](https://isomorphic-git.org/docs/en/walk)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)
- [micromark](https://github.com/micromark/micromark)
- [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)
- [Lezer Markdown](https://github.com/lezer-parser/markdown)
- [SQLite FTS5 consistency](https://sqlite.org/fts5.html#external_content_tables)

## Revised execution sequence

### Stage 0 — prove the bottleneck

Add internal counters and profiling around:

- tree manifests built and reused;
- blobs read and bytes read;
- per-processor raw bytes parsed;
- readable/inspected path counts;
- proposal iterations and garden sub-Proposals;
- run/effect counts;
- heap allocation/retention during a real one-page adoption.

Use current runs only. Record a real work-vault baseline after restarting the
host on the exact code being tested.

Exit gate: the measurements identify the top two avoidable costs and can
distinguish tree I/O, raw parsing, broad dispatch, and model work.

### Stage 1 — unify revision source access

- Introduce internal `RevisionSource`.
- Replace the walkers in `compileRange`, `makeSnapshot`, and projection rebuild.
- Reuse manifests and blob Promises across candidate revisions.
- Preserve current Snapshot capability wrapping unchanged.
- Test nested docs-vault prefixes, add/modify/delete ordering, concurrent reads,
  eviction, and byte-identical compile-range results.

No processor behavior, parser, database, manifest, or public SDK interface
changes in this stage.

Exit gate: old and new `CompileRangeResult` values are identical, the three
walkers become one implementation, and live tree/blob reads fall as predicted.

### Stage 2 — attack one proven broad parser

Start with `dome.markdown.lint-supersession`, not a universal artifact.

- Measure its parse sub-steps: frontmatter status, wikilinks, and resolver
  construction.
- Share only a content-pure scanner that has at least two callers, likely raw
  wikilink matches or frontmatter parse status.
- Keep supersession policy and link-resolution behavior in `dome.markdown`.
- Shadow-run old and new paths over the full work vault; compare diagnostics
  canonically.
- If access to blob identity is required, introduce the minimal
  capability-scoped `DocumentSource`; do not add relationship methods.

Exit gate: the target processor's p95 and allocations improve materially with
no diagnostic difference.

### Stage 3 — remeasure and choose one branch

After several active workdays, choose based on evidence:

- **Cold start/rebuild dominates:** persist one JSON artifact row per
  `(blob_oid, extractor_id, extractor_version)` using Bun.sqlite.
- **One cross-document lookup dominates:** add that one inverted index and its
  narrow interface, probably link identity/backlinks first.
- **Cumulative fixed-point reruns dominate:** write a separate design for
  output identities and adjacent-delta scheduling.
- **RSS remains high outside these paths:** heap-profile the actual retaining
  module; do not expand the document compiler by reflex.
- **None dominates:** stop. The simple module is enough.

## Deferred work

The following are explicitly not approved by this review:

- normalized persistent heading/link/task/claim/section tables;
- a universal core artifact containing extension semantics;
- feature-to-processor dependency declarations;
- persistent revision/path catalogues;
- grant-fingerprint resolver caches;
- task-anchor, claim-key, and semantic-token indices built together;
- adjacent-delta scheduling without output-identity design;
- direct artifact-to-projection writes;
- deterministic page splitting as part of the cache project;
- a generic incremental computation framework;
- a new Markdown parser without a corpus parity spike;
- 10,000-page architecture driven only by synthetic targets.

Deferred does not mean rejected forever. Each item now has an evidence gate.

## Correctness gates

Even the simplified module must prove:

- same revision produces the same sorted path/blob manifest;
- `diff(base, head)` remains byte-equivalent to current compile-range output;
- raw blob content is never confused across revisions or paths;
- effective read grants retain today's null/filter behavior;
- deleted paths remain visible to cleanup routing;
- cache eviction changes performance only;
- projection rebuild still dispatches processors and routes Effects through
  `applyEffect` and the broker;
- restart with an empty cache produces identical adopted/projection state.

## Final recommendation

Approve Stage 0 and Stage 1 only.

The original plan's product thesis remains right: immutable source structure
should be reused and work should eventually propagate through actual semantic
dependencies. The simplest safe path is to deepen the source-revision seam
first and let real measurements determine whether Dome next needs parser
memoization, one relationship index, persistence, or scheduler work.

This revision is substantially smaller and more coherent:

```text
now:       RevisionSource + measurement
next:      one proven parser/index optimization
conditional: persistence OR relationship index OR scheduler redesign
never by default: a second generic computation platform
```
