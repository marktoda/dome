---
type: spec
created: 2026-07-18
updated: 2026-07-18
sources:
  - "[[cohesive/plans/2026-07-17-self-contained-distribution]]"
description: "Versioned, deterministic policy for the owner Markdown that belongs to Dome's compiled knowledge universe"
---

# Content scope

Content scope is the complete set of owner Markdown that Dome may treat as its
compiled knowledge universe. It is a content policy, not a filesystem walker,
page taxonomy, capability, or permission. Feature-specific selectors and
capability grants may narrow this universe; neither may silently broaden it.

The pure policy Module lives at `src/core/content-scope.ts`. Its small
interface validates and canonicalizes one scope, decides membership for one
candidate path, and deterministically selects from a caller-supplied path
inventory. The Module performs no I/O and contains no Git, engine, processor,
or capability logic.

## Version 1 contract

```yaml
content_scope:
  version: 1
  include:
    - "**/*.md"
  exclude:
    - "private/**"
```

Fresh vaults persist this mapping inline in `.dome/config.yaml`. For an
existing valid config that predates content scope, setup creates the separate
versioned `.dome/content-scope.yaml` document instead of rewriting owner
configuration. That overlay is deliberately narrow: it must be a YAML mapping
with exactly `content_scope`. It is invalid without a base config. When both
documents carry a scope, their canonical values must be equal or the policy
fails closed.

`resolveCapabilityPolicyDocuments` is the single resolution seam for live
filesystem loads, revision-bound reads, setup inspection, and scaffold
validation. `foundConfig` derives only from the base config, and the resolved
scope—not its storage location—participates in the capability-policy hash.
The long-running `dome serve` host treats both policy documents as runtime
inputs. An adopted overlay change therefore closes and reopens the runtime;
the changed policy hash makes the projection cache stale and the adoption
host rebuilds it before stamping the new adopted revision. No separate
projection-global path list entry is required: that list owns candidate-bound
configuration whose meaning is not already represented in a cache key.

`version` is the literal `1`. `include` contains at least one glob; `include`
and `exclude` each contain at most 64 globs. Persisted and revision-bound
contracts are lexically sorted and duplicate-free. The ergonomic constructor
accepts unordered duplicates and returns the canonical sorted, de-duplicated,
recursively frozen value. Invalid input returns structured validation errors;
it does not throw. Raw array lengths are checked before any element is
validated, and at most 16 validation errors are returned, so pattern/element
validation and diagnostics cannot amplify beyond the contract budgets.
Validation compiles a passive snapshot from already-inspected data
descriptors; accessor-backed fields/elements are refused, and neither Zod nor
canonicalization rereads the caller's object or arrays.

JavaScript `Proxy` inputs are rejected through `node:util.types.isProxy`
before any property, descriptor, or own-key trap can run. For non-Proxy plain
objects and arrays, unknown **enumerable string keys** are rejected using one
`Object.keys` pass. That pass is necessarily linear in the raw submitted key
count; the contract makes no constant-work claim for an arbitrarily wide
plain object. Non-enumerable and symbol metadata is ignored and never copied.
This preserves strict unknown-field rejection for the canonical JSON/YAML
shape without bulk descriptor enumeration.

Globs are non-empty, vault-relative POSIX patterns of at most **8,192
characters per glob**, interpreted by `Bun.Glob`. Absolute patterns,
backslashes, empty or dot path segments, trailing slashes, and control
characters are invalid. Bun owns metacharacter syntax acceptance; Dome does
not place a narrower hand-written parser in front of it. Matching is
case-sensitive. Tests pin the version-1 behavior of `**`, root and nested
matches, dot paths, braces, character classes, and literal metacharacters such
as `[[]`, `[*]`, and `[?]` so a Bun behavior change cannot silently
reinterpret stored policy. A deliberate matching-language change requires a
new content-scope version and migration.

## Membership order

Given a candidate string:

1. Parse it through the canonical vault-relative POSIX path constructor.
   Duplicate separators collapse; absolute paths, backslashes, dot segments,
   empty paths, and trailing slashes fail closed.
2. Require a case-sensitive `.md` suffix. `.MD` and non-Markdown files are
   outside the content universe regardless of globs.
3. Reject the non-overridable private floor: `.dome/**` and `.git/**`. An
   include glob cannot admit either namespace.
4. If any `exclude` glob matches, reject the path.
5. Admit the path only when at least one `include` glob matches.

Exclusion therefore wins. Selection canonicalizes and de-duplicates candidates
before returning a lexically sorted, frozen path list. It examines path strings
only; callers must not read excluded file content merely to build a preview.

## Relationship to capabilities and feature selectors

Content scope answers “does this owner Markdown belong to Dome's knowledge
universe?” A capability grant answers “may this processor observe or affect
this path?” They are independent policies with different owners. Content
scope grants no read, write, search, graph, or model power.

For an applicable processor, the effective content set is conceptually:

```text
candidate owner Markdown
  ∩ ContentScope
  ∩ declared and granted read paths
  ∩ feature-specific selector
  ∩ declared and granted write paths (when emitting a patch)
```

A feature may narrow scope—for example, a daily-date selector can choose one
daily note—but must never substitute an independent `wiki/**`, `notes/**`, or
`**/*.md` content-universe policy. Infrastructure configuration and operational
state are not owner Markdown and use their existing narrow capability paths;
they are not exceptions that broaden ContentScope.

The cached Bun matcher lives at the neutral `src/core/glob-match.ts` seam.
`src/engine/core/glob-cache.ts` is a compatibility re-export for existing
capability and trigger imports, so all policies still share one implementation
and one matcher cache.

## Rollout status

The version-1 policy Module and setup-contract binding ship in the first M4
checkpoint. The read-only setup compiler validates both its in-memory proposal
and exact rendered YAML `content_scope` through the canonical schema. The
runtime capability-policy parser consumes the same config seam, and content
scope participates in its deterministic policy hash. Existing Dome vaults
without a scope receive an explicit reviewed create-only scope document;
malformed, orphaned, or conflicting documents block setup. The inspector
inventories only lowercase-`.md` candidates.
Processor enumeration, scope inference for arbitrary layouts, explicit apply
consent, and projection rebuild behavior remain later M4 checkpoints. Until
those land, this contract does not claim that existing processors already
consume ContentScope.

The setup inspector fixture contains both `lowercase.md` and
`case-variant.MD`: only the former enters its tracked or untracked Markdown
inventory. Later scope-preview work must preserve that distinction when it
adds covered/excluded counts and representative evidence.

The engine-local `glob-cache` compatibility re-export is temporary. The final
M4 checkpoint must migrate every source and test import to
`src/core/glob-match.ts`, delete the compatibility file and its engine-module
matrix row, and add a structural test proving no old import remains.

## Related

- [[wiki/invariants/CONTENT_SCOPE_BOUNDS_OWNER_MARKDOWN]]
- [[wiki/specs/setup]]
- [[wiki/specs/capabilities]]
- [[wiki/specs/vault-layout]]
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]
