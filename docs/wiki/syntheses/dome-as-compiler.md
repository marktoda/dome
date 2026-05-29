---
type: synthesis
created: 2026-05-28
updated: 2026-05-28
sources: ["[[VISION]]", "[[wiki/specs/adoption]]", "[[wiki/specs/harnesses]]", "[[wiki/specs/cli]]", "[[wiki/concepts/llm-wiki-pattern]]"]
status: draft
tags: ["compiler", "architecture", "positioning"]
---

# Dome as a compiler — anatomy, where the analogy breaks, and what to borrow

Dome is framed as "a compiler for your second brain" ([[VISION]]), and the framing is repeated as a load-bearing rule: the *compiler boundary* (AGENTS.md + CLI + compiler host + git-native writes) is the contract every agentic harness interacts with ([[wiki/specs/harnesses]]). This synthesis tests that framing against how real compilers are actually built — which parts of the analogy are structural rather than rhetorical, where it quietly breaks, and which ideas from compiler-construction history are worth importing.

The claim it argues: **the framing is structural, not marketing — but "compiler" undersells the runtime shape. Dome is closer to a *language server + incremental build system for prose* than to a batch front-to-back compiler, and that reframing is what generates the most valuable feature ideas (an LSP, a query-based incremental engine, a provenance debugger) rather than bolting them on.**

## The framing is structural, not rhetorical

Three independent signals say the compiler word is earning its keep:

1. **Incremental compilation is a named primitive.** [[wiki/specs/adoption]] defines `compileRange(base, head)` → `changedPaths` + synthesized signals. That is exactly what an incremental compiler does: compute the changed set, recompile only it.
2. **The engine is a fixed-point loop.** The adoption loop runs adoption-phase processors, applies auto-patches, and repeats until no processor emits a new patch — with a `MAX_ITER` cap as the runaway backstop. This is fixpoint iteration, the same shape as iterative dataflow analysis and many optimization pipelines.
3. **Provenance is compiler-grade.** Every Fact carries a SourceRef into an adopted commit, and projections are rebuildable from markdown alone ([[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]], [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]). Those are *source maps* and a *hermetic build cache* — the properties that make a real compiler trustworthy.

A subtle place where Dome is *ahead* of a naive compiler: the fixed-point loop sidesteps the pass-ordering problem. LLVM ships a whole pass manager because pass ordering is fragile (inline-then-fold ≠ fold-then-inline). Dome doesn't order its passes; it iterates the whole set to convergence, which is robust to processor visitation order the same way iterative dataflow analysis is robust to block visitation order.

## Anatomy map: compiler stage → Dome equivalent

| Classic compiler stage | Dome equivalent | Fit |
|---|---|---|
| Source text | Committed markdown in the vault | exact (it is the "source of truth") |
| Lexer + parser → AST | `dome.markdown` parses frontmatter / headings / wikilinks / regions | strong |
| Compilation unit | A page (file) | strong |
| Incremental recompile (changed set) | `compileRange(base, head)` → `changedPaths` + signals | exact |
| Name resolution / symbol table | Wikilink resolution; projection store (facts, fts5) as symbol DB | strong |
| Type checking / semantic analysis | [[wiki/specs/page-schema]] + Zod validation + adoption-phase diagnostics | strong |
| Diagnostics (codes, severities) | `DiagnosticEffect` with stable codes + `severity: "block"` ([[wiki/specs/effects]]) | exact |
| Linker (resolve symbols across units) | Bidirectional wikilinks; broken wikilink = unresolved symbol | strong |
| Optimization passes to a fixpoint | The adoption loop itself ([[wiki/specs/adoption]]) | exact |
| IR / semantic database | Projection store ([[wiki/specs/projection-store]]) | strong |
| Source maps / debug info | SourceRef on every Fact — "no claim without a SourceRef" | exact, unusually rigorous |
| Build cache / reproducible build | `refs/dome/adopted` + rebuildable projections + `dome rebuild` | exact (Bazel/Nix hermeticity) |
| Sandbox / effect discipline | Capability broker at the single applier chokepoint | strong (it is an effect system) |
| Macro expansion + recursion limit | Garden patches re-entering adoption + `garden.cascade-cap` | strong analogy |
| Error-recovering checker vs. strict build | `dome lint` (walks all, reports everything) vs. adoption (atomic, blocks) | already a clean duality |

The two rows that matter most are **SourceRef = source maps** and **rebuildable projections = a hermetic build cache**. For a product whose pitch is "allergic to ungrounded confidence," having compiler-grade provenance encoded as named invariants is the core of the trust story, not a detail.

## Where the analogy breaks

Two honest cracks — and each points at an opportunity.

### 1. Dome's optimizer is stochastic

A real compiler is deterministic by construction; its optimizer never produces different code on a different day. Dome's most important passes are LLM-driven garden processors, and the loop's entire correctness story is *engineering determinism back on top of a non-deterministic pass*. Three of the vault's own gotchas are exactly this scar: [[wiki/gotchas/processor-idempotency]], [[wiki/gotchas/processor-fixed-point-divergence]], [[wiki/gotchas/agent-prompt-regression]]. No compiler textbook has a chapter on "what if the constant-folder hallucinates."

This is the real frontier — and compiler theory happens to hold the best defensive tools for it: referential transparency, memoization keyed on input hash, and golden/snapshot tests for passes.

### 2. "Compiler" undersells the runtime shape

`gcc` is a batch transform you re-run from scratch. Dome is a *continuously-running daemon maintaining an incrementally-updated semantic database that answers queries on demand and accretes for years*. That is not the compiler — it is the rest of the modern toolchain: the build system + the incremental query engine + the language server.

The most generative reframing: **Dome is a language server for prose.** Not a downgrade — the language server *is* the compiler frontend, run continuously and exposed interactively. Adopting that frame predicts the LSP feature below rather than bolting it on, because the projection store is already the semantic database an LSP serves from.

## Ideas from compiler history, ranked by fit

### 1. An actual LSP — clean, because of the adapter pattern

[[wiki/specs/cli]] already gestures at this (`dome serve` can run "like an LSP/watch process"), but that is a *watch process*, not a language server. A real LSP over the dirty working tree (pre-commit), live in Obsidian / VS Code, would give:

- **Live diagnostics** — broken wikilinks, schema violations, orphans, contradictions as squiggles *while you type*, instead of in a report file *after* you commit. Shifts diagnostics left of adoption.
- **Completion** — autocomplete `[[entity]]` names; suggest cross-references as you write.
- **Hover** — hover a wikilink → entity summary; hover a derived claim → provenance + confidence.
- **Go-to-definition / find-references** — jump from a fact to its SourceRef; "find all claims citing this source."
- **Code actions (quick-fixes)** — `dome lint --apply <id>` is already a fix-it; an LSP surfaces it as an inline lightbulb.
- **Rename refactoring** — rename an entity, atomically rewrite every wikilink/backlink (project-wide symbol rename).

Why it is architecturally cheap: the protocol-adapter seam already exists. [[wiki/matrices/protocol-adapter]] describes `AbstractSurface` with `renderMcp` today and planned `renderHttp` / `renderVoice`. **LSP is just `renderLsp(buildAbstractSurface(vault))` — a third adapter beside CLI and MCP.** The backend (passes, diagnostics, symbol DB) is already built; LSP is a frontend protocol over it. This is the same realization the Roslyn / rust-analyzer teams had: the language server is the compiler exposing its query layer, not a separate tool.

### 2. A query-based incremental engine (rustc / salsa "red-green")

Highest-leverage *architectural* idea, and it directly defuses crack #1. Modern incremental compilers (rustc's query system, the `salsa` framework, Roslyn) model compilation as demand-driven, memoized queries over a dependency graph: each derived fact is a pure function of named inputs; when an input's hash changes, only transitively-dependent queries re-run.

Dome invalidates coarsely today (`processor-version-drift` re-runs affected rows; `compileRange` scopes to changed paths). The finer idea: **content-address each processor's output by the hash of its inputs** (Bazel's action cache). Two payoffs:

- **Speed** — editing one page re-runs only the passes whose actual inputs changed, not every adoption processor over the changed range.
- **Determinism, nearly for free** — a memoized stochastic pass becomes *stable by caching*: same input hash → same cached output, so the LLM is not re-rolled on every sync. That turns [[wiki/gotchas/processor-idempotency]] from "hope the model is deterministic" into "the cache makes it deterministic unless inputs genuinely changed." This is the compiler-theory answer to the stochastic-optimizer problem.

Natural refinement riding on this: **interface vs. implementation hashing** (Rust's metadata hash / ML `.mli` files). A page's *interface* is its frontmatter + emitted facts; its *implementation* is the prose body. If the interface did not change, downstream pages need not recompile even if the body did — separate compilation, applied to knowledge.

### 3. A provenance debugger: `dome explain <fact>`

Compilers ship `rustc --explain E0502` and debuggers give stack traces. Dome has the raw material for something better: the run ledger ([[wiki/specs/run-ledger]]) + Dome-* commit trailers + SourceRefs mean **every belief in the vault has a full derivation chain**. A `dome explain` verb — "*why* does the vault claim X? show the source pages, the processor run, the commit" — is a time-travel debugger for knowledge. For a product whose north star is grounded confidence, "show your work" as a first-class command is arguably more on-brand than the LSP, and it is cheap: a read over substrate already ledgered.

### Smaller borrows

- **Error-code index** — `dome explain <diagnostic-code>` (Rust's `--explain`); stable codes already exist.
- **Compiler Explorer (godbolt) for prose** — a side-by-side "raw note → what the compiler did to it" diff view; good for trust and for debugging garden passes.
- **Profile-guided gardening (PGO)** — use *recall patterns* (what gets queried / revisited) to prioritize which cold regions to compile and cross-reference. Optimize the hot paths of attention. (Speculative.)
- **Golden / snapshot tests for passes** — the standard defense against optimizer drift; the direct mitigation for [[wiki/gotchas/agent-prompt-regression]].

## Where this leads

Two ideas are concrete and architecturally *invited* by what already exists: the **LSP adapter** (cheapest, most visibly compiler-like, rides the `AbstractSurface` seam) and the **query-based incremental engine** (deepest — pays off speed and the determinism problem at once). The provenance debugger is the most on-brand. The rest are conversational.

If any of these graduates from idea to design, it should run through the substrate-first brainstorm flow so it lands against the existing specs and invariants rather than beside them.

## Related

- [[VISION]] — the "compiler for your second brain" framing this synthesis tests.
- [[wiki/concepts/llm-wiki-pattern]] — Karpathy's pattern Dome productizes ([[wiki/entities/andrej-karpathy]]).
- [[wiki/specs/adoption]] — the fixed-point loop and `compileRange`.
- [[wiki/specs/harnesses]] — the compiler-boundary contract.
- [[wiki/specs/cli]] — `dome serve` as the first compiler host; `dome lint` as the error-recovering checker.
- [[wiki/matrices/protocol-adapter]] — the `AbstractSurface` seam an `renderLsp` would join.
- [[wiki/specs/projection-store]] — the semantic database an LSP / query engine serves from.
- [[wiki/gotchas/processor-idempotency]], [[wiki/gotchas/agent-prompt-regression]] — the stochastic-optimizer scars.
