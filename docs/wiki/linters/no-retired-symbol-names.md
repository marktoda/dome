---
type: linter
created: 2026-05-27
updated: 2026-05-27
status: v1 (proposed; lockstep-check landing in Phase 1 of implementation)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# no-retired-symbol-names

**Status:** v1 substrate; the proposed structural fence against retired-vocabulary drift in normative docs. The lockstep check ships as part of Phase 1 of v1 implementation per the brainstorm's "Phasing the cut" section.

**Statement:** Normative documentation under `docs/wiki/**/*.md` (specs, invariants, matrices, gotchas, concepts, entities, sources, syntheses, linters) does not reference symbols, concepts, or filenames from the retired v0.5 substrate. The check greps for a closed allowlist of retired names; any hit fails CI.

## What it checks

The check is a regex sweep over `docs/wiki/**/*.md` for the retired-name allowlist below. Hits in *normative context* (claims about how Dome works) fail. Hits inside `## History`, `## Migration from <version>`, or explicit `> Pre-v1:` quote prefaces are allowed — they document what the system used to do.

**Retired primitive concepts** (when used as canonical-mechanism names; historical narration ok):
- `Tool` (in code-symbol or normative-concept context — e.g., "the Tool catalog", "Tool returns", "Tool error").
- `Hook` (when narrating the v0.5 → v1 transition is ok; not ok as a present-tense concept).
- `Workflow` (v1 has garden-LLM processors, not workflows).
- `BoundToolSurface`, `runWorkflow`, `WorkflowRegistry`, `PromptLoader`, `projectAiSdk`, `projectMcp`, `McpToolName`, `ConsumerSurface`, `buildConsumerSurface`.
- `wrapMutatingInvoke`, `TOOL_REGISTRY`, `MUTATING_TOOL_NAMES`, `TOOL_NAMES`.
- `registerHook`, `HookDispatcher`, `HookRegistry`, `HookContext` (as user-facing types).
- `reconcile` as a present-tense exported function name (v1 has `dome sync` user-side; `src/engine/adopt.ts` implementation-side). Historical references in `## Migration` sections are allowed.
- `vault.tools`, `vault.dispatchEvents` (from external/plugin code; engine-internal uses are invisible to docs).
- `.dome/hooks/`, `.dome/tools/`, `.dome/cli/`, `.dome/prompts/` (as committed-vault directories — replaced by `.dome/extensions/<bundle>/`).
- `.dome/state/scheduled.json` (replaced by `projection.db.schedule_cursors`).
- `.dome/state/last-reconciled-sha.txt` (replaced by `refs/dome/adopted/<branch>`; the `.dome/state/last-reconcile-mtime.txt` marker is preserved as the source for the v1.x `dome inspect drift-age` subject — the pre-recut `dome doctor --time-since-reconcile` flag name is retired).
- `SENSITIVE_GOES_TO_INBOX` (retired in the compiler-reframe pre-v1; carried forward to v1).

**Retired invariant names** (these `.md` files no longer exist; `[[wiki/invariants/<name>]]` links to them are dead):
- `HOOKS_CANNOT_BYPASS_TOOLS`
- `HOOK_DISPATCH_IS_VAULT_BOUND`
- `INDEX_AND_LOG_ARE_DISPATCHER_OWNED`
- `PAGE_TYPE_BY_DIRECTORY`
- `WIKILINKS_ARE_FULLPATH`
- `PAGE_CREATION_REQUIRES_RECURRENCE`
- `WORKFLOWS_KNOW_VAULT_CONTEXT`

**Retired+renamed invariants** (the old names; new names are in the current substrate):
- `EVERY_WRITE_IS_LOGGED` → `EVERY_EFFECT_IS_LEDGERED`
- `VAULT_RECONCILES_AFTER_NATIVE_WRITE` → `ALL_MUTATION_GOES_THROUGH_ADOPTION`
- `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` → `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY`

**Retired matrices** (the `.md` files no longer exist):
- `tool-invariant-enforcement`

**Retired+renamed matrices**:
- `event-types-and-payloads` → `effect-router-targets`
- `consumer-surface` → `protocol-adapter`
- `intent-prompt-tools` → `intent-prompt-processors`

**Retired+renamed gotchas**:
- `hook-cycle` → `processor-fixed-point-divergence`
- `hook-non-idempotent` → `processor-idempotency`

**Retired specs** (the `.md` files no longer exist):
- `wiki/specs/hooks`
- `wiki/specs/prompts-and-workflows`

**Retired linter spec** (no longer in v1):
- `wrap-mutating-invoke-consumption`

## Exempt contexts

Hits are tolerated when:

1. **The doc is dated history.** Sections under `## History`, `## Migration from <version>`, or `## Pre-v1 notes` may name retired vocabulary as historical reference.
2. **The reference is in the linter spec itself.** The check excludes `docs/wiki/linters/no-retired-symbol-names.md` from its own sweep — this file is the canonical home of the allowlist and necessarily names every retired symbol.
3. **The reference is in archival cohesive substrate** under `docs/cohesive/reviews/`, `docs/cohesive/brainstorms/`, `docs/cohesive/delta-ledgers/`, or `docs/cohesive/substrate-discovery/`. These are append-only design history that may carry pre-rename terminology; the scanner skips them.
4. **The retired name is part of a longer current-vocabulary token.** E.g., `effect-router-targets` is not a hit for `tool-invariant-enforcement`.

## Why this exists

The v0.5 → v1 substrate rewrite retires significant vocabulary. The rewrite catches what its author thought to touch; cross-references from "untouched" docs to retired files survive silently. Without a structural fence, the substrate's link graph fails its self-teaching property at the first dead click — a contributor following `[[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]]` learns the link is broken and either guesses or asks; either outcome is worse than CI catching the regression at PR time.

This linter is the structural fence that the pass-1 validate-rewrite review (`docs/cohesive/reviews/2026-05-27-dome-v1-engine-model-rewrite-validation.md`) explicitly named as the substrate gap behind findings B1, B2, B3, and B5.

## Implementation sketch (v1 Phase 1)

```bash
# scripts/check-retired-symbols.sh
set -euo pipefail
RETIRED_NAMES=(
  # primitives
  "BoundToolSurface" "runWorkflow" "WorkflowRegistry" "wrapMutatingInvoke"
  "TOOL_REGISTRY" "MUTATING_TOOL_NAMES" "registerHook" "HookDispatcher"
  "ConsumerSurface" "buildConsumerSurface" "projectMcp" "McpToolName"
  # retired invariants
  "HOOKS_CANNOT_BYPASS_TOOLS" "HOOK_DISPATCH_IS_VAULT_BOUND"
  "INDEX_AND_LOG_ARE_DISPATCHER_OWNED" "PAGE_TYPE_BY_DIRECTORY"
  "WIKILINKS_ARE_FULLPATH" "PAGE_CREATION_REQUIRES_RECURRENCE"
  "WORKFLOWS_KNOW_VAULT_CONTEXT" "SENSITIVE_GOES_TO_INBOX"
  # retired+renamed invariants
  "EVERY_WRITE_IS_LOGGED" "VAULT_RECONCILES_AFTER_NATIVE_WRITE"
  "CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY"
  # retired matrices/specs/gotchas/linter
  "tool-invariant-enforcement" "event-types-and-payloads" "consumer-surface"
  "intent-prompt-tools" "hook-cycle" "hook-non-idempotent"
  "wiki/specs/hooks" "wiki/specs/prompts-and-workflows"
  "wrap-mutating-invoke-consumption"
  # retired filesystem paths
  ".dome/hooks/" ".dome/tools/" ".dome/cli/" ".dome/prompts/"
  ".dome/state/scheduled.json" ".dome/state/last-reconciled-sha.txt"
)

failures=()
for name in "${RETIRED_NAMES[@]}"; do
  hits=$(grep -r -l -F --include="*.md" "$name" docs/wiki \
    --exclude="*no-retired-symbol-names*" || true)
  if [ -n "$hits" ]; then
    failures+=("$name: $hits")
  fi
done

if [ ${#failures[@]} -gt 0 ]; then
  printf '%s\n' "${failures[@]}"
  exit 1
fi
```

Run via `bun test tests/integration/no-retired-symbol-names.test.ts` (calls the shell script and asserts exit 0) or directly via `scripts/check-retired-symbols.sh`. Integrated into CI per `package.json`'s test target.

## Future expansion

When v1.x retires additional names, authors extend the `RETIRED_NAMES` array. The lockstep test enforces the check; the array is a substrate constant under reviewer control.

## Related

- [[wiki/specs/sdk-surface]] §"Outputs the SDK does not have"
- [[wiki/gotchas/transitive-llm-dependency]] (sister structural fence; bundle-deps catches package-level drift; no-retired-symbol-names catches doc-level drift)
- [[wiki/linters/engine-is-sole-applier]] (sister linter; catches engine-boundary drift)
- [[wiki/linters/processor-purity]] (sister linter; catches processor-boundary drift)
- [[wiki/gotchas/substrate-count-drift]] (related: count-drift uses a similar count-cite-canonical pattern)
