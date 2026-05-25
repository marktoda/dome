---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: medium
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Hook cycle

**Symptom:** A hook handler invokes a Tool. The Tool's effect fires an event. The same hook handler matches the event and runs again. Stack grows unbounded. CPU spikes; eventually the SDK errors with a stack overflow or hangs the harness.

**Root cause:** Hooks call Tools; Tools emit events; events may match the calling hook. Without cycle detection, an auto-cross-reference hook (writes a backlink on `document.written.wiki.entity`) could trigger itself by writing a page, which fires `document.written.wiki.entity` again, which matches the same hook.

**Structural mitigation:** **Depth-limited causation chains.**

The hook dispatcher tracks a *causation chain* per event: when event E1 triggers hook H1, and H1 invokes Tool T1 which produces effect E2, E2 carries a `caused_by: H1` annotation. When E2 matches H1 again (or matches a hook H2 that would close a cycle), the dispatcher checks: is depth > 5?

- If depth ≤ 5: the chain proceeds.
- If depth > 5: the dispatcher emits `hook.cycle-detected` with the full chain payload, refuses to fire the hook, and logs an entry to `log.md`.

The depth limit of 5 is configurable in `.dome/config.yaml`:

```yaml
hooks:
  max_causation_depth: 5
```

Most legitimate hook chains complete in 1-2 steps. Five is generous; values above 5 likely indicate a design issue (or a legitimately deep workflow like multi-pass research, which should set the value explicitly).

**Specific scenarios:**

- **Auto-cross-reference hook.** Writes `[[wiki/entities/danny]]` into other pages when entity `danny` is created. Each of those writes fires `document.written.wiki.entity` again. With cycle detection: depth tracker sees the chain doesn't include the *same* hook invoked twice on the *same* page, so it's allowed; cross-references propagate; chain terminates when no more pages need backlinks. Without cycle detection: same result *if* the hook is careful, infinite loop *if* it's not.
- **Index-update hook on every page write.** Writes to `index.md` on every `document.written.wiki.*`. The index update fires `document.written.index`, which the hook doesn't match (good). No cycle.
- **Contradiction-detection hook.** When a page changes, scans related pages for contradictions; if found, writes a flag to the new page's frontmatter. The flag-write fires `document.written.wiki.<type>` which... could match the same hook. With cycle detection: second invocation against the same page is flagged at depth=2 and skipped.

**Operational notes:**

- The `hook.cycle-detected` event has its own handler (default: log + email/notify) so the user sees that cycles are being prevented. A flood of these events is a signal that a registered hook is poorly designed.
- The causation chain includes hook IDs and Tool calls in order — `dome doctor --show recent-hook-cycles` lists recent detections for debugging.
- Hook authors are encouraged to use specific event patterns (`document.written.wiki.entity` not `*`) to avoid accidentally matching their own emitted events.

**Related:**
- [[wiki/specs/hooks]] §"Cycle prevention"
- [[wiki/matrices/event-types-and-payloads]]
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]
