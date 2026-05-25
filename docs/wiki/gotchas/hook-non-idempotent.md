---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: high
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Hook non-idempotent

**Symptom:** A user-registered hook handler runs twice (or N times) for the same event during reconciliation. Side effects accumulate: duplicate cross-references appear on pages, the same Slack notification fires repeatedly, an external webhook gets called twice, a counter increments by 2 instead of 1.

**Root cause:** Dome's hook system provides **at-least-once delivery**. During reconciliation (`dome reconcile`, or automatic startup-reconcile in `dome serve`), events may be re-fired in two places:

- **State diff** — `git status --porcelain` + `git diff <last-sha> HEAD` shows a file changed; reconcile fires the matching event regardless of whether a previous hook run completed.
- **Scheduled catch-up** — a scheduled hook whose interval has elapsed fires once on reconcile.

Reconciliation does not track per-event completion (no lockfile mechanism). It re-derives "what should fire" from filesystem + git + `scheduled.json`. The safe assumption is "re-fire" — combined with per-workflow atomic commits, this means hooks may legitimately fire twice for the same logical change if a previous run committed partial state and crashed before completing.

Hooks that are **idempotent** tolerate this by being no-ops on the second fire. Hooks that aren't produce duplicate effects.

**Structural mitigation:** **Idempotency is a contract for hook authors.**

Every hook handler — programmatic or declarative — must be safe to re-fire on the same event. Shipped defaults are idempotent by construction:

- `auto-update-index` regenerates the same index entry; re-running produces the same `index.md` content.
- `auto-cross-reference` writes the same `[[wikilink]]` to the same page; markdown allows duplicate wikilinks but the write is content-identical on second fire (no diff).
- Intake hooks like `ingest` move the inbox file out on completion; if re-fired, the inbox file is already gone, the workflow exits early.

User and plugin hooks declare idempotency explicitly:

```yaml
# .dome/hooks/notify-on-new-entity.yaml
event: document.written.wiki.entity
workflow: notify
idempotent: false        # this hook is not idempotent; reconciliation will skip it
```

When `idempotent: false`, reconciliation does NOT re-fire the hook automatically. The user is responsible for tracking what's been processed (typically by checking the page's `updated:` timestamp against an external store).

For programmatic hooks:

```ts
registerHook("document.written.wiki.entity", {
  idempotent: false,
  async handler({ path, diff }, ctx) { ... }
});
```

**How to make a non-idempotent hook idempotent:**

- **Check before acting.** A "notify on new entity" hook can check whether the notification was already sent (e.g., via a sent-notifications log) before sending again.
- **Use deduplicating sinks.** If sending to Slack, use a thread/message-id derived from the event payload — Slack will dedupe.
- **Make the effect content-addressed.** A cross-reference hook writes `[[wikilink]]` text; the second write produces no diff because the text is already there.

**Anti-patterns:**

- A counter hook that increments a counter on every event fire. Not idempotent. Either: (a) declare `idempotent: false` and accept reconcile-skipping; (b) re-design to store the counter as a function of event-ids seen (a set) rather than an integer.
- A hook that calls a non-idempotent external API (POST that creates new resources without an idempotency-key header). Either: (a) use the API's idempotency-key mechanism; (b) declare `idempotent: false`.

**Test guarantee:** No SDK-level mechanical test. The eval suite ([[wiki/gotchas/agent-prompt-regression]]) runs each shipped workflow twice on the same fixture and asserts the second run produces identical effects to the first. Plugin authors are expected to add similar tests.

**Related:**
- [[wiki/specs/hooks]] §"Durability and reconciliation"
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]
- [[wiki/invariants/INBOX_IS_EPHEMERAL]]
- [[wiki/gotchas/hook-cycle]]
