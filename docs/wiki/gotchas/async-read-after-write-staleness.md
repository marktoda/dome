---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: low
coverage: off-matrix
enforced_at: src/hook-dispatcher.ts
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Async read-after-write staleness

**Symptom:** A user writes a page through their harness, then immediately asks the harness "what does that page say?" Sometimes the read returns content that doesn't yet reflect a hook-proposed follow-on update (e.g., the auto-cross-reference hook hasn't run yet).

**Root cause:** Hooks run async by default (see [[wiki/specs/hooks]] §"Execution model"). The originating write commits to disk before the hook dispatcher fires matching events. A read immediately after the write sees the post-write state but not the post-hook-effects state.

This is by design. Sync hooks would block writes; for hooks that do non-trivial work (LLM calls for sensitivity classification, network calls for sync), sync mode would make the user-facing latency unbearable. Async-by-default is the right tradeoff for the common case.

**Structural mitigation:** **Sync-mode opt-in for hooks that must complete before reads see the result.**

A hook may declare `async: false` (declarative form) or pass `{ sync: true }` to `registerHook` (programmatic form). Sync hooks run inline before the Tool returns to the caller. The caller-visible latency is the sum of the Tool's own work plus all sync hooks.

Reserved sync uses:

- **Sensitivity classification on ingested content.** The classifier must run before the writer decides which destination (wiki vs inbox/review). Declared sync.
- **Schema validation on extension-typed pages.** Future use.
- **Index update on page write.** The `auto-update-index` shipped-default hook is async by default; for a user about to query immediately after writing, declaring it sync ensures the index is current before the query loads. Trade-off: small added write latency.

**Specific scenarios:**

- **User writes a page; immediately asks "what does it say?"** Read returns the post-write content. If the user expected post-hook content (e.g., auto-cross-references), they'll see them after the hook completes — typically within seconds.
- **User writes a sensitive item; expects it routed to inbox.** The sensitivity-classifier hook MUST run before the write commits to a wiki page, so it's declared sync. The user-facing latency is acceptable because they're not waiting interactively; the agent decides destination during composition.
- **User writes a page; runs `dome doctor`.** `dome doctor` is deterministic and reads the markdown directly; it sees the post-write state regardless of hook completion.

**Operational notes:**

- The async queue size is monitored. If async hooks pile up faster than they drain, `vault.queue-backpressure` is emitted (configurable threshold). v0.5's in-process queue is typically fine; v1+ may need a more robust queue under heavier loads.
- Users can force queue drain via `dome doctor --drain-hooks` if they want to read post-hook state explicitly.

**Don't try to make everything sync.** That's a tempting fix but it pessimizes the common case. The async-by-default pattern is correct; sync-mode opt-in for specific hooks is the right escape hatch.

**Related:**
- [[wiki/specs/hooks]] §"Execution model"
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]
- [[wiki/gotchas/hook-cycle]]
