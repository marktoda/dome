---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: shipped-default
---

# INBOX_IS_EPHEMERAL

**Tier:** Shipped default — enabled in every vault that has any intake configured; can be disabled per-bucket via `.dome/config.yaml` for buckets where the user wants persistent inbox files.

**Statement:** Files under `inbox/<bucket>/` are *pending* by virtue of their presence. When an intake hook completes processing a file, the hook MUST move or delete the file so it no longer appears under `inbox/<bucket>/`. The default behavior for shipped intakes is to **move** the file to `raw/<source-type>/<filename>` (preserving the captured content as an immutable raw source per [[wiki/invariants/RAW_IS_IMMUTABLE]]).

**Why:** This is what makes the reconciliation model trivial. The presence of a file in `inbox/<bucket>/` IS the durability signal — "this file has not been processed." After processing, the file leaves the inbox. `dome reconcile` walks inbox/ on startup and fires `document.written.inbox.<bucket>` events for every file still there, knowing they're either freshly captured or stranded from a previous crash. Either way, processing them is correct.

Without this contract, reconciliation would need a separate "processed marker" mechanism (a `.processed` file alongside, a frontmatter flag, an external database, parsing `log.md`). All of those introduce extra state. With this contract, the filesystem IS the state.

**Structural enforcement:** Two layers, complementary.

1. **Workflow-prompt instruction (primary).** The intake-workflow prompts themselves carry the contract: the `ingest`, `voice-ingest`, `research`, and `clip-integrate` workflow prompts each include explicit instructions to `deleteDocument(inbox_path)` as the final step of the workflow.

2. **`dome doctor` structural fallback (secondary).** Because the primary layer is prompt-enforced (not Tool-boundary-enforced — see [[wiki/matrices/tool-invariant-enforcement]] §"`INBOX_IS_EPHEMERAL` — workflow-enforced (off-matrix)"), it is vulnerable to prompt regression. `dome doctor` walks `inbox/<bucket>/` for every bucket except `review/` (because `review/` is a destination for the `SENSITIVE_GOES_TO_INBOX` opt-in invariant, not an intake — see [[wiki/specs/hooks]] §"`inbox/review/` — opt-in sensitivity destination") and emits a violation for every file whose `mtime` is older than `hooks.inbox_stale_age_hours` in `.dome/config.yaml` (default 24h). A vault that intentionally wants long-lived inbox files raises `hooks.inbox_stale_age_hours` arbitrarily high; a dedicated per-bucket disable is deferred to v0.5.1+ (see §"Per-bucket disable" below).

**v0.5 escape mechanism:** Intake workflows `deleteDocument` the inbox file at end of workflow. The "move to `raw/captures/`" mechanism described in earlier drafts conflicts with [[wiki/invariants/RAW_IS_IMMUTABLE]] (`writeDocument` and `moveDocument` both refuse `raw/` targets); deletion is the structurally clean exit. Raw content survives in the wiki pages the workflow created and in any `wiki/sources/<name>.md` source page; a future `appendRawCapture` privileged dispatcher API may preserve raw content directly (v1+).

The doctor check above is what catches a stranded inbox file — typically a sign that an intake hook failed to complete or was never registered.

**Counter-example:** A user writes a plugin that processes `inbox/clip/` files but doesn't move them out. After processing, the files remain in `inbox/clip/`. On the next `dome reconcile` run, the system fires the intake events again, the plugin re-processes — and depending on its idempotency story, may produce duplicate wiki updates. The fix: the plugin must move or delete the inbox file as part of its workflow contract.

**Per-bucket disable (deferred to v0.5.1+):** A future v0.5.1+ mechanism may let a vault disable the doctor check for a specific bucket — useful for an "always-on review queue" UX where capture files stay visible in `inbox/<bucket>/` until explicitly resolved. The intended config shape is:

```yaml
# .dome/config.yaml (planned, not implemented in v0.5)
inbox:
  buckets:
    review:
      ephemeral: false   # inbox/review/ items stay until explicitly resolved
```

The v0.5 mechanism for the same use case is to raise `hooks.inbox_stale_age_hours` arbitrarily high in `.dome/config.yaml`. The dedicated `inbox.buckets.<name>.ephemeral` knob lands when a shipped intake genuinely needs it; `inbox/review/` itself is already excluded from the doctor walk unconditionally (because `review/` is a destination, not an intake) and does not need the per-bucket knob.

**Test guarantee:** `tests/invariants/inbox-is-ephemeral.test.ts` — two layers of tests:

1. **Workflow-prompt layer:** asserts each shipped intake workflow (`ingest`, `voice-ingest`, `research`, `clip-integrate`) binds `deleteDocument` in its `tools:` frontmatter list AND its prompt body instructs deletion of the inbox file.
2. **Doctor-fallback layer:** writes a fixture inbox file with a backdated `mtime` past the configured threshold; asserts `dome doctor` emits a violation. Also asserts `inbox/review/` files are excluded from the check regardless of age, since `review/` is the `SENSITIVE_GOES_TO_INBOX` destination, not an intake bucket.

**Related:**
- [[wiki/specs/hooks]] §"Opt-in intake patterns" and §"Durability and reconciliation"
- [[wiki/specs/cli]] §"dome reconcile"
- [[wiki/invariants/RAW_IS_IMMUTABLE]]
- [[wiki/gotchas/hook-non-idempotent]]
