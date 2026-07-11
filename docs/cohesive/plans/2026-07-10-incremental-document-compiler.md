# Incremental document compiler

**Date:** 2026-07-10
**Status:** pressure-tested; north-star design only
**Origin:** [[cohesive/reviews/2026-07-09-first-principles-product-review]]
**Decision:** build a content-addressed Document Compiler, not a generic
incremental-query framework

> [!IMPORTANT]
> The simplicity review at
> [[cohesive/reviews/2026-07-10-incremental-document-compiler-pressure-test]]
> supersedes this document's implementation sequence. Do not execute the work
> packages below as one project. Start with the internal `RevisionSource`, no
> new dependency and no persistent cache; let measurements earn every later
> layer.

## Executive decision

Dome should compile each distinct Git blob into one immutable, lossless
document artifact, reuse that artifact everywhere, and propagate changes by
the artifact features that actually changed. Cross-document behavior should
use explicit materialized indices for the few real relationships Dome has:
paths and aliases, wikilinks, task anchors, claims, and searchable sections.

The external module should remain small:

```ts
type DocumentCompiler = {
  revision(commit: CommitOid): Promise<CompiledRevision>;
};

type CompiledRevision = {
  readonly commit: CommitOid;
  readonly tree: TreeOid;
  readonly documents: DocumentIndex;
  changesSince(base: CompiledRevision): Promise<DocumentDelta>;
};
```

`revision(commit)` hides Git tree reuse, blob reads, parsing, persistent
artifact caching, secondary-index construction, schema versions, concurrency,
and bounded eviction. `changesSince` hides Merkle-tree differencing, feature
hash comparison, and cross-document affected-set computation.

The processor interface receives a capability-scoped adapter over the same
compiled revision. Existing raw `Snapshot` reads remain available for
compatibility and unusual plugin behavior. First-party processors migrate to
compiled documents and continue to emit ordinary Effects. No extraction or
mutation bypasses the processor runtime or capability broker.

This is deliberately not Salsa-in-TypeScript. Dome's pure common denominator
is the markdown document. Processor outputs also depend on grants, extension
configuration, phase, time, operational stores, model providers, and proposal
context. Treating every processor as a memoized pure query before all of those
reads are registered would produce fast stale answers.

## Why this is P0

The work vault is approximately 1,000 markdown files and 7.65 MB. That is not
a large corpus, but current behavior already includes:

- multiple processors independently walking the whole markdown tree;
- links, frontmatter, tasks, claims, sections, and fences parsed repeatedly;
- adoption iterations diffing `adopted..candidate` from scratch, so every
  iteration replays the cumulative changed range;
- nine processors with recurring timeout evidence in the live doctor report;
- a point-in-time 3.4 GB resident compiler process;
- 172,853 run rows and 8,048,739 capability-use rows;
- a synthetic 1,000-file performance test added to keep two whole-vault lints
  below five seconds after a recent blob-OID read optimization.

The recent `Snapshot` optimization is good: one tree walk plus direct blob
reads is materially better than resolving every path through Git repeatedly.
It optimizes the storage access, however, not the compilation model. Every
processor still owns parsing and several still own a whole-vault algorithm.

The desired asymptotic behavior is:

```text
one ordinary page edit
  = O(changed bytes)
  + O(changed extracted features)
  + O(actual cross-document dependents)
  + O(resulting Effects)

not O(total vault bytes × matching processors × fixed-point iterations)
```

## First principles

### Correctness comes before reuse

An incremental result is correct only when it is observably equivalent to a
clean rebuild from the same adopted tree and processor set. A cache hit is
never evidence of correctness by itself.

The core oracle is:

```text
incrementalCompile(edit sequence).canonicalState
  == cleanCompile(final tree).canonicalState
```

Canonical state includes document artifacts, projection facts, search rows,
diagnostics, open questions, and the final candidate tree. It excludes run ids,
timestamps, and other intentionally operational values.

### Git already chose the compilation-unit identity

A file path is not content identity. Git blobs are immutable and
content-addressed. The same bytes at the same or a different path share a blob
OID; unchanged files across commits retain their OIDs. Therefore:

```text
ArtifactKey = (blobOid, documentCompilerVersion)
```

The commit and path are bound later when producing SourceRefs or applying
path-specific rules. Artifact rows must not embed commit ids, file paths,
last-changed times, grants, or vault configuration.

### Cache semantic structure, not Effects

The safe reusable value is the source-derived artifact. An Effect is not a
pure function of blob contents alone: it carries SourceRefs bound to a commit
and path and may vary by processor version, grant, configuration, phase, or
operational input.

Caching Effect arrays would couple invalidation to nearly every subsystem and
could replay an effect under the wrong authority. First-party processors
should cheaply translate compiled artifacts into fresh Effects on each real
invocation.

### Whole-file parsing is initially sufficient

Do not begin with incremental parsing inside one markdown file. A changed
100 KB page is cheap to reparse once. The current problem is parsing unchanged
files repeatedly across processors and iterations.

The first artifact compiler should call the existing characterized extraction
functions so task and claim fence dialects remain exactly compatible. A later
one-pass tokenizer is justified only by measurements. The cache seam yields
most of the leverage without risking source-identity behavior.

### Global behavior needs explicit relationships

Some results genuinely depend on more than one document:

- adding or removing a page changes wikilink resolution elsewhere;
- changing supersession status affects inbound links;
- settling a carried task affects its canonical origin;
- changing a claim may create or remove a same-key conflict;
- changing title, description, type, or status affects rendered catalogues;
- duplicate detection compares semantic metadata across pages.

These are not reasons to rescan every file. They are reasons to maintain the
specific inverted indices that answer “which documents can this change
affect?”

## Research conclusions

The recommended design borrows principles, not frameworks:

- Git's object model makes blobs the natural artifact key and trees a Merkle
  index over paths. Unchanged subtrees can be skipped by comparing tree OIDs.
  See [Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects).
- Salsa's red-green algorithm re-executes a changed query, compares its new
  value with the prior value, and stops propagation when the value is
  unchanged. Dome should do this with feature hashes, not only raw blob OIDs.
  See [Salsa's algorithm](https://salsa-rs.github.io/salsa/reference/algorithm.html).
- Skyframe gets correct fine-grained invalidation only because computations
  obtain every input through the dependency engine. It explicitly warns that
  direct reads create incorrect incremental builds. Dome processors still
  have raw snapshot, clock, config, store, and model inputs, so a generic
  dynamic query graph would be unsound until those reads are registered. See
  [Skyframe](https://bazel.build/versions/6.6.0/reference/skyframe).
- *Build Systems à la Carte* defines minimality as executing a task at most
  once and only when it transitively depends on changed inputs. That is the
  target for deterministic Dome processors, while scheduled/model processors
  remain deliberately outside it. See
  [the paper](https://simon.peytonjones.org/assets/pdfs/build-systems-original.pdf).
- SQLite FTS external-content tables require explicit consistency maintenance
  and a rebuild path. Dome should keep search projection writes transactional
  through its current sink rather than make the document cache a second FTS
  authority. See [SQLite FTS5](https://sqlite.org/fts5.html#external_content_tables).

## Workload classification

The current code has three different workload shapes. They should not share
one invalidation strategy.

| Shape | Examples | Correct incremental strategy |
| --- | --- | --- |
| Document-local extraction | graph links/tags, claims index, task index, search sections, frontmatter lint/normalization | compile only changed blobs; compare feature hashes; translate the changed artifact feature into Effects |
| Cross-document deterministic analysis | wikilink validation, supersession lint, task reconciliation, index rendering, orphan detection | update explicit inverted indices; inspect changed documents plus actual dependents |
| Scheduled/on-demand synthesis | semantic garden, brief, query/export-context, active projects | read compiled catalogues and indices; O(vault) metadata scans may be acceptable on schedule, but never re-read/reparse all source bytes |

Model processors are not memoized by this design. They benefit because their
selection and navigation inputs become cheap and bounded.

## Design alternatives

### A. Keep `Snapshot` and add more memoization

Cache tree walks, raw blob strings, and perhaps a few parser results inside
`makeSnapshot`.

Advantages:

- smallest code change;
- no processor interface migration;
- useful for repeated reads inside one adoption iteration.

Why it is insufficient:

- the cache dies with each snapshot/revision;
- parser ownership and grammar duplication remain distributed;
- cross-document processors still scan the vault;
- cumulative fixed-point iterations still rerun the same work;
- there is no clean-rebuild equivalence interface to test.

This is the shallow design: callers still know and implement nearly all the
complexity.

### B. Introduce a generic Salsa/Skyframe-style query engine

Represent every processor computation as a tracked `Key -> Value` query and
record dependencies dynamically.

Advantages:

- theoretically precise invalidation;
- automatic dependency discovery;
- eventual parallel evaluation and early cutoff.

Why it is wrong now:

- processor reads are not hermetic or fully registered;
- adoption Effects and model calls are not pure query values;
- converting every extension at once creates a high-risk platform rewrite;
- the interface would expose query keys, durability, revisions, and dependency
  semantics to extension authors;
- debugging a stale dynamic edge would be harder than the present full scan.

This design may become appropriate after first-party deterministic reads all
cross the Document Compiler and real workloads demonstrate a need.

### C. Compile Git blobs and maintain explicit document relations

Parse each blob once, store source-derived artifacts, compute feature hashes,
and maintain the handful of real cross-document indices.

Advantages:

- Git provides perfect content identity;
- migration can happen processor by processor;
- cache entries are trivially disposable;
- explicit dependency rules are inspectable and testable;
- clean rebuilds use the same interface;
- no change to the four core concepts or Effect authority.

Cost:

- requires a real shared markdown artifact contract;
- cross-document affected-set rules must be specified carefully;
- a bounded persistent cache and revision cache need lifecycle ownership.

This is the recommended design. It maximizes leverage while keeping
invalidation knowledge local.

## Recommended module

### Seam placement

Place the module under `src/documents/`. Its only public export file is
`src/documents/index.ts`; internal parsing, SQLite, Merkle walking, revision
indices, and eviction stay behind it.

Dependencies are:

- **in-process:** extraction, normalization, feature hashing, delta and
  affected-set computation;
- **local-substitutable:** Git object reads and Bun.sqlite. Tests use real
  temporary Git repositories and temporary SQLite databases, as existing
  engine tests do. No public storage port is warranted.

The deletion test passes: deleting this module would redistribute parsing,
artifact identity, schema versioning, cache lifecycle, link resolution,
backlinks, anchor lookup, and feature-delta logic back across dozens of
processors.

### Processor-facing interface

`CompiledRevision.documents` is capability-scoped before it enters a
ProcessorContext. A useful starting interface is:

```ts
type DocumentIndex = {
  get(path: string): Promise<CompiledDocument | null>;
  all(): Promise<ReadonlyArray<DocumentRef>>;
  resolveWikilink(input: {
    readonly sourcePath: string;
    readonly target: string;
  }): WikilinkResolution;
  backlinks(path: string): ReadonlyArray<DocumentLinkRef>;
  tasksByAnchor(anchor: string): ReadonlyArray<DocumentTaskRef>;
};
```

`get` and `all` replace repeated raw reads and list walks. The other three
methods hide the relationships currently rebuilt independently by link and
task processors. If evidence does not show at least two callers for a proposed
new lookup, keep it internal rather than growing this interface.

The capability-scoped adapter must preserve today's non-disclosure behavior:

- `get` returns null for unreadable paths;
- `all` excludes unreadable paths;
- resolution and ambiguity are computed against the readable set, not a
  global set later filtered;
- backlinks and task-anchor lookups return only readable sources and targets;
- resolver caches are keyed by the effective read-grant fingerprint.

This last point is load-bearing. Filtering after link resolution could reveal
that an unreadable target exists or change an ambiguity result.

### Raw compatibility

Keep these existing Snapshot methods during migration:

```ts
readFile(path)
listMarkdownFiles()
getFileInfo(path)
```

They should be backed by the same compiled revision's tree manifest and raw
blob cache. Third-party and unusual model tools remain functional. New
first-party deterministic processors should not parse raw markdown when the
artifact already contains the needed structure.

## Core data structures

### 1. Tree manifest

One compiled revision holds a sorted path manifest:

```ts
type DocumentPathEntry = {
  readonly path: string;
  readonly blob: BlobOid;
};
```

Represent it as both:

- a sorted frozen array for deterministic traversal and merge-diff; and
- a `Map<string, BlobOid>` for point lookup.

At 1,000–10,000 documents this is compact and simpler than introducing a HAMT.
The module caches Git tree-node reads by immutable `TreeOid`, so constructing a
new revision skips unchanged subtrees. Revision objects are held in a small
LRU, initially four revisions, so fixed-point iterations can compare adjacent
candidates without unbounded memory.

Do not persist `(commit, path)` rows for every intermediate commit. Per-effect
plumbing commits would turn that into another accreting registry.

### 2. Blob artifact store

Use a separate recomputable `.dome/state/documents.db`. It survives projection
rebuilds so a rebuild can reuse unchanged parses, but it may be deleted at any
time.

The primary key is `(blob_oid, compiler_version)`. Blob OIDs are treated as
opaque strings rather than assuming SHA-1 length.

Suggested header table:

```sql
CREATE TABLE document_artifacts (
  blob_oid TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  frontmatter_json TEXT,
  line_starts BLOB NOT NULL,
  structure_hash TEXT NOT NULL,
  frontmatter_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  tag_hash TEXT NOT NULL,
  task_hash TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  search_hash TEXT NOT NULL,
  compiled_at TEXT NOT NULL,
  PRIMARY KEY (blob_oid, compiler_version)
);
```

Feature rows are normalized child tables keyed by the same pair plus an
ordinal:

```text
document_headings
document_links
document_tags
document_tasks
document_claims
document_sections
```

Normalized rows avoid deserializing every artifact to build backlinks or task
lookups and let the store batch-load one feature for many blobs. The module
still returns immutable TypeScript values; SQL is implementation detail.

### 3. Lossless ranges

Every structural row stores:

- 1-indexed start/end lines;
- zero-indexed UTF-16 offsets suitable for slicing the JavaScript source
  string;
- start/end character columns where the current SourceRef contract needs
  them;
- a stable per-blob ordinal or structural id.

`line_starts` is a packed `Uint32Array` BLOB. It supports fast arbitrary line
range reads without keeping split line strings resident. The raw markdown
continues to live only in Git.

Heading rows include the exact raw section span through the next heading of
equal or lower level. Preamble is an explicit span. This enables a future
split plan to name exact spans while deterministic code moves the original
bytes losslessly.

### 4. Feature hashes

Each hash is computed from canonical serialization of one extracted feature,
not raw text:

- `structure_hash`: headings and lossless ranges;
- `frontmatter_hash`: parsed keys relevant to Dome plus parse status;
- `link_hash`: targets, aliases, fragments, and ranges;
- `tag_hash`: normalized tags and ranges;
- `task_hash`: task identity, state, body, dates, priority, section, ranges;
- `claim_hash`: stable id, key, value, as-of date, ranges;
- `search_hash`: title/breadcrumb/section text emitted to search.

These provide Salsa-style early cutoff. If prose changes but `task_hash` does
not, task-dependent work does not propagate. If formatting changes but
`link_hash` is identical, backlink analysis remains green.

Feature hashes are an optimization, never truth. A version change invalidates
the artifact and recomputes every hash.

### 5. Revision-scoped secondary indices

Build these lazily from the revision's path manifest plus artifact rows:

```text
path -> DocumentRef
normalized basename/title/alias -> readable paths
resolved target path -> incoming link refs
unresolved normalized target -> link refs
task anchor -> task refs
claim key -> claim refs
semantic token -> document refs
```

The first implementation may build them once in O(extracted rows) for a warm
revision. Later revisions derive them from the prior revision plus
`DocumentDelta`; unchanged buckets are structurally shared or copied on write.

Do not persist every revision's secondary indices. The persistent value is the
blob artifact; revision indices are bounded acceleration over immutable Git
trees.

## Compilation algorithms

### Artifact cache miss

```text
read blob once from Git
  -> run existing characterized extractors
  -> compute canonical feature hashes
  -> insert header + all child rows in one SQLite transaction
  -> return immutable CompiledDocument
```

Concurrent misses for the same artifact key share one in-flight Promise in
the process. The SQLite primary key makes cross-process duplicate compilation
benign: one transaction wins and the other reads the completed artifact.

Partial artifact rows are never visible. A failed compilation rolls back and
surfaces an ordinary processor/runtime failure when requested.

### Merkle revision diff

Compare Git trees recursively:

1. Equal tree OIDs mean the entire subtree is unchanged; stop.
2. For changed tree nodes, merge their sorted entries by name.
3. Equal blob OIDs are unchanged.
4. Added, changed, and deleted blobs become `DocumentPathDelta` rows.
5. Compile only added/new blob OIDs.
6. Compare old/new feature hashes to produce semantic deltas.

The result distinguishes raw path changes from semantic feature changes:

```ts
type DocumentPathDelta =
  | { kind: "added"; path: string; next: DocumentRef }
  | { kind: "modified"; path: string; prior: DocumentRef; next: DocumentRef }
  | { kind: "deleted"; path: string; prior: DocumentRef };

type DocumentFeatureDelta = {
  readonly path: string;
  readonly changed: ReadonlySet<DocumentFeature>;
};
```

Renames initially remain delete+add. Blob identity means the artifact is still
reused. Rename detection can be presentation metadata later; correctness does
not require it.

### Fixed-point worklist

The current loop recompiles `adopted..candidate` each iteration. Replace that
with adjacent-revision deltas:

```text
R0 = compiled(adopted)
R1 = compiled(proposal head)
run processors affected by delta(R0, R1)
apply auto patches -> R2
run processors affected by delta(R1, R2)
...
no auto patch -> fixed point
```

Projection effects from earlier iterations remain in a change-aware buffer.
A later successful run replaces the same processor/path subjects; a processor
that is not affected again retains its earlier output. At convergence, publish
the canonical buffered projection delta through the existing sinks.

This preserves fixed-point semantics while turning the loop into a real
worklist. It also reduces run-ledger rows because processors do not fire on the
entire cumulative proposal range every iteration.

The worklist change must not ship without equivalence tests over multi-pass
patch cascades, deletions, diagnostics clearing, questions, and facts.

### Cross-document affected sets

The initial rules are explicit:

| Change | Additional affected documents |
| --- | --- |
| path/title/alias added or deleted | unresolved links with the same normalized identity; collision group for the basename/title/alias |
| link set changed | changed source; old and new resolved target backlink buckets |
| status/superseded-by changed | documents linking to that page |
| task feature changed | every task ref sharing the changed anchor |
| claim feature changed | same canonical subject/key group |
| catalogue metadata changed | the affected generated category index |
| search feature changed | only that path's FTS rows |

Fuzzy wikilink suggestions are the awkward case: a new page can theoretically
change the closest suggestion for many unresolved targets. Maintain an
unresolved-target vocabulary and compare the new identity only against those
keys. This is O(unresolved targets), not O(all markdown bytes), and is honest
about the actual dependency.

## Parser artifact contract

The first artifact should contain at least:

```ts
type CompiledDocument = {
  readonly ref: DocumentRef;
  readonly frontmatter: ParsedFrontmatter;
  readonly headings: ReadonlyArray<DocumentHeading>;
  readonly links: ReadonlyArray<DocumentLink>;
  readonly tags: ReadonlyArray<DocumentTag>;
  readonly tasks: ReadonlyArray<DocumentTask>;
  readonly claims: ReadonlyArray<DocumentClaim>;
  readonly sections: ReadonlyArray<DocumentSection>;
  slice(range: DocumentRange): Promise<string>;
};
```

The artifact is structural, not semantic truth. It says “these bytes match the
task grammar,” not “this task deserves attention”; “this is a claim line,” not
“the claim is current.” Processors retain domain decisions.

Malformed frontmatter and malformed generated blocks are values with parse
problems, not artifact-cache failures. Lint processors need the artifact to
represent invalid source faithfully enough to emit diagnostics.

## Invariants

Add named invariants only when implementation begins and their mechanical
tests are clear. The design requires these contracts:

1. **Artifacts are content-addressed.** Same blob OID and compiler version
   produce byte-equivalent artifact rows.
2. **Compiled state is disposable.** Deleting `documents.db` changes
   performance, never behavior.
3. **Incremental equals clean.** Canonical outputs match a rebuild for the
   same tree.
4. **Document indices respect read grants.** No resolution or relationship
   query observes unreadable paths.
5. **Effects remain processor outputs.** The compiler never writes facts,
   diagnostics, questions, search rows, or patches directly.
6. **Candidate revisions never mix.** Every artifact binding and SourceRef is
   associated with the exact compiled revision being processed.
7. **Artifact schema changes are loud.** A compiler-version mismatch causes
   recomputation, not partial decoding or silent fallback.

## Storage and memory lifecycle

- Keep at most four fully materialized revision indices in memory initially.
- Cache tree-node reads by `TreeOid` under a byte-bounded LRU.
- Cache raw blob strings only while referenced by an active revision/run;
  artifact rows persist, raw markdown does not.
- Keep artifact rows reachable from the current adopted tree unconditionally.
- When `documents.db` exceeds its budget, remove least-recently-seen
  unreachable artifact keys in batches and vacuum opportunistically.
- Start with a 256 MB hard cache target and a doctor warning at 128 MB for a
  10 MB vault; tune from soak data.
- WAL checkpoints and schema migration use the shared SQLite connection/open
  module.

The cache should not write a “last accessed” timestamp on every read. Batch a
`last_seen_at` update once per compiled revision to avoid converting reads into
write amplification.

## Performance and correctness gates

Use a realistic 1,000-page fixture and a larger 10,000-page synthetic fixture.
Targets exclude model/network work:

| Gate | 1,000 pages / ~10 MB | 10,000 pages / ~100 MB |
| --- | ---: | ---: |
| warm one-page artifact compile | < 25 ms | < 25 ms |
| one-page deterministic adoption, p95 | < 500 ms | < 1.5 s |
| no-op compiler tick | < 100 ms | < 500 ms |
| cold document-cache rebuild | < 10 s | < 60 s |
| warm projection rebuild | < 5 s | < 30 s |
| steady compiler RSS after soak | < 512 MB | < 1.5 GB |
| incremental/clean canonical equivalence | 100% | 100% |

These are initial engineering targets, not public promises. Measure on the
same supported machine class and record hardware/runtime versions.

The most important benchmark is work avoided:

```text
compiled blob count
parsed byte count
revision paths touched
feature deltas produced
cross-document dependents inspected
processors invoked
Effects routed
```

Wall time alone can improve accidentally while invalidation becomes
incorrect.

## Implementation plan

### Work package 0 — measurement and equivalence oracle

- Add internal counters around tree reads, blob reads, parsed bytes, artifact
  hits/misses, artifact rows loaded, and processor inspected paths.
- Capture a sanitized workload profile from the live vault.
- Add a canonical projection snapshot helper that removes operational ids and
  timestamps.
- Build a randomized edit-sequence test: add, edit, delete, rename, settle a
  task, change a link target, change supersession, and apply an auto patch;
  compare incremental results with a clean rebuild after every step.
- Record the current baseline before architecture changes.

Exit criterion: the test can detect an intentionally omitted invalidation and
the live baseline identifies bytes parsed and paths inspected per tick.

### Work package 1 — pure document artifact

- Create `src/documents/` with one public `index.ts`.
- Define path-independent artifact types and canonical feature hashes.
- Initially compose the existing characterized extractors; do not rewrite
  markdown grammar.
- Add packed line starts and exact heading/preamble spans.
- Add interface tests for valid and malformed documents, both historical
  fence dialects, Unicode offsets, generated blocks, wrapped claims, duplicate
  anchors, and oversized pages.

Exit criterion: one blob compiles deterministically and supplies every feature
needed by the first migration processors.

### Work package 2 — persistent artifact store and compiled revisions

- Add `documents.db` through the shared SQLite open/migration seam.
- Implement transactional cache misses and in-flight Promise deduplication.
- Implement TreeOid-cached Merkle walking and bounded revision LRU.
- Implement `revision(commit)` and `changesSince(base)`.
- Make existing Snapshot raw methods delegate to the compiled revision without
  changing caller behavior.
- Add delete-the-database and schema-version mismatch tests.

Exit criterion: a second revision compiles only new blob OIDs; process restart
reuses artifact rows; deleting the cache produces identical values.

### Work package 3 — migrate document-local processors

Migrate in this order because each step is easy to compare with its current
pure extractor:

1. `dome.graph.links` and `dome.graph.tag-index`;
2. `dome.search.index-text`;
3. `dome.claims.index` and claim stamping/render inputs;
4. `dome.daily.task-index` and task syntax/stamping inputs;
5. frontmatter/page-status/stale-date lints.

Processors still construct Effects and SourceRefs. For each migration, run old
and new extraction in shadow mode on fixtures and the live vault and compare
canonical output before deleting the old parse path.

Exit criterion: changed documents are read from one artifact, and all migrated
processor outputs are byte-equivalent after canonicalization.

### Work package 4 — adjacent-revision fixed-point worklist

- Change adoption compilation from cumulative `adopted..candidate` every
  iteration to adjacent compiled revisions.
- Make the buffered projection state replace processor/path outputs across
  iterations.
- Route only processors matching the adjacent raw/semantic delta.
- Preserve diagnostics/questions/facts cleanup for deleted and re-inspected
  paths.
- Add cascade tests where processor A patches a path that triggers processor B,
  B patches another path, and A must not rerun unless that new delta affects
  it.

Exit criterion: all existing fixed-point tests pass, randomized equivalence
passes, and multi-iteration proposals stop replaying the cumulative range.

### Work package 5 — cross-document indices

- Build capability-scoped path/title/alias resolution.
- Build resolved/unresolved link and backlink indices.
- Build task-anchor and claim-key indices.
- Replace whole-vault raw scans in wikilink validation, supersession lint,
  task reconciliation, and orphan detection with changed-plus-dependent sets.
- Feed index rendering and garden selection from `DocumentRef` metadata.
- Replace garden duplicate O(n²) all-pairs comparison with an inverted
  distinctive-token candidate set; retain exact scoring on candidates.

Exit criterion: a one-page edit reads no unrelated raw document; global rules
still update every truly affected document in equivalence tests.

### Work package 6 — deterministic range operations

- Add heading/range reads to garden tools backed by artifact spans.
- Change large-page splitting so the model proposes a plan over stable section
  spans and destination metadata.
- Move exact raw spans deterministically and validate a lossless source-range
  partition.
- Keep the output as one `PatchEffect(mode: "propose")`.

Exit criterion: a page larger than the model read budget can be split without
the model reproducing its content, and every original byte is accounted for.

### Work package 7 — rebuild, GC, and dogfood gate

- Make projection rebuild stream artifact features rather than rerunning raw
  parsers.
- Add cache integrity sampling and a full rebuild command path.
- Add bounded artifact eviction and document-cache size reporting.
- Soak the work vault for ten active days.
- Track p50/p95 tick time, parsed bytes, artifact hit rate, affected paths,
  processor invocations, RSS, cache size, and incremental/clean comparisons.

Exit criterion: performance gates hold, no manual cache repair occurs, and the
work vault's deterministic timeout findings disappear.

## Testing strategy

Per the deep-module rule, the Document Compiler interface is the primary test
surface. Do not retain a large parallel suite that asserts internal cache table
operations.

Required interface tests:

- same blob in two paths compiles once but binds distinct path SourceRefs;
- unchanged blob across commits is a cache hit;
- raw edit with identical link/task/claim features triggers early cutoff;
- deletion clears the correct derived relationships;
- new basename turns a unique wikilink into an ambiguity and rechecks inbound
  sources;
- hidden unreadable paths do not affect scoped link resolution;
- task-anchor collision returns every readable origin;
- cache schema bump recompiles;
- cache deletion and clean rebuild are equivalent;
- concurrent requests for one artifact produce one complete row set;
- malformed markdown remains representable and lintable;
- fixed-point adjacent deltas equal cumulative clean compilation.

Keep focused pure tests for the artifact grammar only where they pin committed
source identity. Replace processor parsing tests with output tests through the
processor or compiler interface as each migration lands.

## Risks and deliberate limits

### Risk: centralizing a de facto markdown ontology

Mitigation: artifact fields represent syntax and ranges only. Page importance,
task visibility, claim currentness, and garden judgment remain processor
behavior. Raw reads remain available.

### Risk: invalidation misses

Mitigation: clean-vs-incremental differential tests, explicit relationship
rules, shadow comparisons, cache deletion, and gradual migrations. Prefer a
conservative extra dependent over a missed one.

### Risk: memory moves from raw strings to indices

Mitigation: bounded revision LRU, normalized persistent artifact rows, lazy
feature loads, raw-content lifetime tied to active runs, and RSS gates.

### Risk: another giant SQLite database

Mitigation: artifacts are per distinct blob, feature rows are compact, cache
size is hard-bounded, current blobs are pinned, and everything else is
evictable. Capability-use ledger amplification is a separate fix and must not
be copied into this store.

### Deliberate non-goals

- no generic plugin-defined artifact features in the first version;
- no dynamic Salsa-style dependency tracking;
- no Effect-result cache;
- no model-output cache;
- no inside-file incremental parser;
- no direct projection writes from the compiler;
- no new core concept, Effect kind, processor phase, or user command;
- no attempt to solve commit batching or capability-use aggregation in this
  work package, though fewer invocations will reduce both.

## Open decisions to settle during work package 0

1. Whether `documents.db` should use normalized feature tables exactly as
   sketched or one artifact BLOB plus current-revision inverted tables. The
   benchmark should compare read amplification and migration complexity.
2. Whether `DocumentIndex` is added directly to `Snapshot` or as a sibling
   `ProcessorContext.documents` field. Prefer the sibling field if it keeps raw
   Snapshot compatibility and capability scoping clearer.
3. Whether feature hashes use the existing SHA-256 helper or a faster
   non-cryptographic hash. Prefer SHA-256 initially: artifact volumes are small
   and collision reasoning stays simple.
4. Whether revision secondary indices are immutable in-memory maps or TEMP
   SQLite tables. Start with maps at the current scale; switch only if the
   10,000-page RSS gate fails.

## Final recommendation

Build work packages 0–3 as the first shippable increment. They establish the
deep seam and eliminate repeated parsing without changing fixed-point
scheduling. Measure again.

Then land work packages 4–5 together behind clean-vs-incremental equivalence
tests. That is the point where Dome becomes genuinely incremental rather than
merely faster at full scans.

Work package 6 is the first direct product payoff: deterministic compaction of
the large pages the current system cannot safely repair. Work package 7 is the
release evidence.

The guiding rule is:

> Cache immutable source structure by blob identity; propagate only semantic
> feature changes; make every cross-document dependency explicit; preserve a
> clean rebuild as the correctness oracle.
