---
type: orientation
created: 2026-06-22
updated: 2026-06-22
tags:
  - orientation
  - house-style
  - design
---

# Philosophy — house style

The load-bearing design principles for the Dome SDK codebase. This is the
canonical home for the "house style" line the implementation plans cite; state
a principle here once, link it, don't re-paraphrase it per plan. For the
architecture *vocabulary* these principles are written in — **module,
interface, depth, seam, adapter, leverage, locality**, the deletion test — see
the `codebase-design` skill. For the domain vocabulary, see [[glossary]].

## The principles

- **Pure-decide functions + thin I/O shells.** Keep the decision (what should
  happen) separate from the effect (making it happen). A pure `decide(...)`
  returns a value; a thin shell performs the writes. The shell stays small
  enough to read in one screen; the decision is testable without touching disk,
  git, or the network.

- **Named invariants with mechanical enforcers.** Every load-bearing rule gets
  a named invariant (`docs/wiki/invariants/<SLUG>.md`) pinned by a real test,
  not prose. Prefer enforcement in this order: **structural > check-script >
  prose.** A `never`-exhaustive switch, a DB `CHECK` ↔ TS-union lockstep, an
  import-direction fence — these catch drift at compile/test time. A comment
  asking the reader to be careful catches nothing.

- **Locality > centralization.** Change, bugs, knowledge, and verification
  should concentrate where the thing *is*, not scatter across the callers that
  use it — and not get hoisted into a shared module just because more than one
  place touches it. Centralize a mechanism only when the mechanism is genuinely
  the same; keep a consumer's unique concern in the consumer.

- **Reuse the one shared mechanism; never build a parallel impl.** When a
  capability already exists (e.g. `globMatch` from
  `src/engine/core/glob-cache.ts`), route through it. A second glob matcher, a
  second schema-hash reader, a second store opener is a divergence bug waiting
  to happen — two copies drift, and the drift is silent.

- **Depth is the test of a seam.** A seam earns its place when something real
  varies across it and callers get leverage for the interface they must learn —
  a lot of behaviour behind a small interface. An interface as wide as the union
  of its callers' needs (a config-bag of options and callbacks) is shallow even
  if it has one name. Run the deletion test: if deleting the module would
  *concentrate* complexity that's currently scattered, it earns its keep; if it
  would just *move* the same complexity, it's a pass-through.

## On generalizing at N=1

The working rule is **do not generalize at N=1** — don't build the abstraction
for the second case until the second case exists. But the rule is a **forcing
function against overcomplication, not a ban.** Its job is to stop speculative
abstraction that pays for flexibility nobody needs yet.

Generalizing at N=1 is the right call when the general form is *strictly
cleaner, clearer, more robust, or more extensible* than the specific one — when
genericity **is** the leverage, not a hedge against an imagined future. Two
common cases where N=1 genericity is correct:

- **The seam's whole purpose is extension.** A harness core, a provider-neutral
  step interface, a registry — these are generic by design; the spec's
  extensibility seam *is* the deliverable, so genericity is the point, not
  premature abstraction.

- **The general form removes a real hazard.** If unifying collapses a
  divergence bug (two copies that must stay in lockstep), contains a dangerous
  path (one destructive branch reachable only deliberately), or shrinks a
  genuinely-duplicated mechanism — the generalization is buying robustness
  today, not optionality tomorrow.

The test is not "how many call sites." The test is: **does the general form,
right now, read cleaner and fail safer than N copies of the specific one?** If
yes, generalize. If it only "might help later," wait. When in doubt, design it
twice (see the `codebase-design` skill) and compare the two interfaces on depth,
locality, and seam placement before committing.
