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

**Structural mitigation:** **Two-layer cycle prevention — per-(handler, target) repetition check + depth safety net.**

The dispatcher tracks a *causation chain* per event: when event E1 triggers handler H1 against target path P1, and H1's Tool calls produce effect E2 against path P2, E2 carries a chain annotation `[(H1, P1)]`. When the dispatcher evaluates whether to fire H1 against E2, two checks run:

**Layer 1 — Per-(handler, target) repetition (primary).** Does `(H1, P2)` already appear in E2's chain? If yes, the dispatcher refuses the fire, emits `hook.cycle-detected`, and logs to `log.md`. If no, the fire is allowed even at arbitrary depth. This is what permits legitimate fan-out: `auto-cross-reference` writing backlinks across 30 entity pages produces a depth-30 chain, but each `(handler, target)` pair is unique, so no repetition is detected and the fan-out proceeds.

**Layer 2 — Depth safety net (runaway protection).** If a chain's depth exceeds `hooks.max_causation_depth` (configurable in `.dome/config.yaml`, default 50), the dispatcher refuses the fire regardless of whether `(handler, target)` repeats. This catches malformed chains that grow unboundedly without revisiting any specific target.

```yaml
hooks:
  max_causation_depth: 50
```

Either trigger emits `hook.cycle-detected` with the full chain payload, refuses the fire, and emits a `hook-failed` log entry. The default of 50 is generous — legitimate fan-out across an entity-rich vault may reach depths of 20-40; values below 20 risk false positives on shipped-default hooks. The depth net exists for catastrophic runaway, not as the primary mechanism.

**Specific scenarios:**

- **Auto-cross-reference hook.** Writes `[[wiki/entities/danny]]` into other pages when entity `danny` is created. Each of those writes fires `document.written.wiki.entity` again. The per-(handler, target) check: the chain contains `(auto-cross-reference, danny.md)` from the originating event; each fan-out fire is against a *different* target page (e.g., `platform-team.md`), so `(auto-cross-reference, platform-team.md)` is novel and the fire is allowed. Cross-references propagate; the chain terminates naturally when no more pages need backlinks. No false-positive cycle detection.
- **Index-update hook.** Writes to `index.md` on every `document.written.wiki.*`. The index write fires `document.written.index`, which the hook doesn't subscribe to (its event pattern is `document.written.wiki.*`, not `document.written.index`). No cycle.
- **Contradiction-detection hook (badly designed).** When a page changes, scans related pages for contradictions; if found, writes a flag back into the originating page's frontmatter. The flag-write fires `document.written.wiki.<type>` matching the same handler against the same target. The per-(handler, target) check: `(contradiction-detection, page.md)` is already in the chain → refuse, emit `hook.cycle-detected`. The hook author rewrites the flag to a separate `inbox/review/<page>-contradiction.md` to avoid the cycle.

**Operational notes:**

- The `hook.cycle-detected` event has its own handler (default: log + email/notify) so the user sees that cycles are being prevented. A flood of these events is a signal that a registered hook is poorly designed.
- The causation chain includes hook IDs and Tool calls in order — `dome doctor --show recent-hook-cycles` lists recent detections for debugging.
- Hook authors are encouraged to use specific event patterns (`document.written.wiki.entity` not `*`) to avoid accidentally matching their own emitted events.

**Related:**
- [[wiki/specs/hooks]] §"Cycle prevention"
- [[wiki/matrices/event-types-and-payloads]]
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]
