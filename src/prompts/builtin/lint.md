---
type: workflow-prompt
name: lint
tools: [readDocument, searchIndex, wikilinkResolve, writeDocument, moveDocument, deleteDocument, appendLog]
triggers: [manual:lint, clock:weekly]
description: Detect drift in propose mode; apply a named finding on confirmation.
---

{{include: system-base.md}}

# Lint

The `lint` workflow runs in two modes. Mode is selected by the workflow's user message:

- **Empty user message** → propose mode.
- **User message of the form `apply <id>` or `apply <id1> <id2> ...`** → apply mode.

Any other user-message shape is a malformed invocation: refuse and explain the two valid shapes.

## Propose mode

Walk the vault and surface:

- Orphan pages (no inbound wikilinks)
- Stale claims (`updated:` more than 90 days old AND content references time-sensitive things)
- Missing cross-references (entities mentioned in bodies but not wikilinked)
- Contradictions across pages
- Frontmatter that doesn't match its directory
- Out-of-band edits (pages whose `updated:` doesn't reflect their git mtime)

Write a structured report to `inbox/review/lint-report-YYYY-MM-DD.md` (using today's UTC date) when the vault has `inbox/review/` configured. Otherwise return the report text directly. When a report already exists for today's date, **append a new `## Pass N` section** rather than overwriting — same-day re-runs produce a longitudinal log.

Each finding entry has this shape:

```markdown
### H1. **<one-line title naming the surface>** (HIGH)

**Evidence:** <paragraph quoting offending content with `path:line` references>

**Recommendation:** <paragraph naming the specific change — concrete enough that a re-invocation of this workflow with `apply H1` can execute it without re-deriving intent. Name the exact file path, the change shape (rewrite / move / delete), and the substantive content of the change.>
```

Where:

- **Stable id**: `<severity-letter><index>`. Severity letters: `H`igh, `M`edium, `L`ow. Indices increment within each severity class within the pass and are stable across passes within the same date (a finding promoted from Pass 1 to Pass 2 keeps its id).
- **Title**: one line.
- **Evidence**: at least one `path:line` reference; quote the offending content directly.
- **Recommendation**: must be executable. If the recommendation requires user judgment that the workflow cannot make on its own, mark the finding `(advisory)` in the severity tag — apply mode will refuse to execute advisory findings.

Do not apply fixes in propose mode. The report is the only output.

## Apply mode

The user message is `apply <id>` or `apply <id1> <id2> ...`. For each id, in order:

1. **Locate the report.** Look for files matching `inbox/review/lint-report-*.md`. Pick the lexically newest filename (reports are dated; lexical order matches chronological order). If no report exists, refuse with a clear error naming the expected path pattern.
2. **Find the finding.** Read the report and locate the finding whose id matches. If the same id appears in multiple `## Pass N` sections (because the finding was promoted across passes), use the most recent `Pass N` section's entry. If the id is absent, refuse with a clear error naming the report path and the requested id.
3. **Check applicability.** If the finding is already annotated `Applied:` (idempotency check), refuse this apply with a clear error citing the prior application timestamp. If the finding is annotated `(advisory)`, refuse — advisory findings require human judgment and should not be applied through this workflow.
4. **Execute the recommendation.** Use `writeDocument`, `moveDocument`, or `deleteDocument` as the recommendation requires. Every mutation is logged automatically per [[wiki/invariants/EVERY_WRITE_IS_LOGGED]].
5. **Annotate the report.** Use `writeDocument` to append an annotation line to the finding's entry in the report:

   - On success: `**Applied:** YYYY-MM-DDTHH:MM:SSZ`
   - On failure: `**Apply-failed:** YYYY-MM-DDTHH:MM:SSZ — <reason>`

   Then move on to the next id. A failed apply does not abort the remaining ids.

6. **Summarize.** After all ids have been processed, return a brief summary naming each id and its outcome (applied / failed / refused).

Apply mode treats the report as the source of truth for the recommendation. The workflow does NOT re-derive intent from current vault state; the apply-time judgment was made at propose time and is recorded in the report. If apply-time vault state has drifted enough that the recommendation no longer makes sense, that is an `Apply-failed:` outcome — re-run propose to surface the new state.
