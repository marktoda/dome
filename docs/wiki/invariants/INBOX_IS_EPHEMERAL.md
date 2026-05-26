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

**Structural enforcement:** The contract is enforced by the intake-workflow prompts themselves. The `ingest`, `voice-ingest`, `research`, and `clip-integrate` workflow prompts each include explicit instructions to `deleteDocument(inbox_path)` as the final step of the workflow.

**v0.5 escape mechanism:** Intake workflows `deleteDocument` the inbox file at end of workflow. The "move to `raw/captures/`" mechanism described in earlier drafts conflicts with [[wiki/invariants/RAW_IS_IMMUTABLE]] (`writeDocument` and `moveDocument` both refuse `raw/` targets); deletion is the structurally clean exit. Raw content survives in the wiki pages the workflow created and in any `wiki/sources/<name>.md` source page; a future `appendRawCapture` privileged dispatcher API may preserve raw content directly (v1+).

The `dome doctor` command reports any vault where inbox/<bucket>/ contains files older than 24 hours — typically a sign that an intake hook failed to complete or was never registered.

**Counter-example:** A user writes a plugin that processes `inbox/clip/` files but doesn't move them out. After processing, the files remain in `inbox/clip/`. On the next `dome reconcile` run, the system fires the intake events again, the plugin re-processes — and depending on its idempotency story, may produce duplicate wiki updates. The fix: the plugin must move or delete the inbox file as part of its workflow contract.

**Per-bucket disable:** A vault that wants to keep capture files visible in the inbox forever (e.g., for an "always-on review queue" UX) can disable this for that bucket:

```yaml
# .dome/config.yaml
inbox:
  buckets:
    review:
      ephemeral: false   # inbox/review/ items stay until explicitly resolved
```

When ephemeral is false, the intake hook is responsible for tracking processed state another way (typically a frontmatter flag).

**Test guarantee:** `tests/invariants/inbox-is-ephemeral.test.ts` — runs each shipped intake workflow against fixture inbox files; asserts the inbox file is gone (moved or deleted) after the workflow completes. Asserts `dome doctor` flags inbox files older than the configured age threshold.

**Related:**
- [[wiki/specs/hooks]] §"Opt-in intake patterns" and §"Durability and reconciliation"
- [[wiki/specs/cli]] §"dome reconcile"
- [[wiki/invariants/RAW_IS_IMMUTABLE]]
- [[wiki/gotchas/hook-non-idempotent]]
