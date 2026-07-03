# Intake Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the deterministic macOS calendar fetch template (`icalbuddy-calendar.sh`) so the daemon lands `sources/calendar/<date>.md` before the morning compile, plus the one AGENTS.md interface sentence and the doc updates the ownership ladder assigns to the product.

**Architecture:** Zero engine-code changes. A new SDK-shipped fetch-command template (vault-side data, same handler contract as `claude-calendar.sh`), one sentence in the vault AGENTS.md template, spec/recipe doc updates, and shell-contract tests mirroring the existing template's test harness. The `/morning` skill and vault rollout are client/operator steps outside this plan (the controller performs them post-merge).

**Tech Stack:** POSIX sh + awk (template), Bun + TypeScript tests.

**Design doc (read first):** `docs/cohesive/brainstorms/2026-07-02-intake-close-design.md`

## Global Constraints

- Zero engine/source-code changes under `src/` EXCEPT `src/cli/commands/init-templates.ts` (one sentence) — anything else is scope creep.
- The template honors the handler contract verbatim (see `assets/source-handlers/claude-calendar.sh` header): invoked from vault root as `<command> <date> <output_path>`; `$1` is the fire-date's local day; pathspec-scoped `git -c commit.gpgsign=false commit … -- "$f"`; commit-only retry when `$f` exists; exit non-zero on any failure; never commit a broken file.
- Output lines must satisfy `parseMeetingLine` (`assets/extensions/dome.daily/processors/calendar-day.ts:57-86`): `- HH:MM–HH:MM — Title (attendees: a, b)`; time `\d{1,2}:\d{2}` with optional dash-joined end; attendees suffix optional; all-day events are title-only bullets (`time: null`).
- **An empty day still writes and commits the file** (frontmatter + heading, zero bullets): present-empty = "known: no meetings"; absent = "unknown". Never exit non-zero for an empty agenda.
- Deterministic output: `LC_ALL=C`, explicit `icalBuddy -tf '%H:%M'`; no locale-dependent formatting.
- Worktree: `/Users/mark.toda/dev/dome/.claude/worktrees/intake-close+build`, branch `intake-close/build`. Never touch the main checkout.
- Typecheck gate `bun run typecheck`; scope tests per task; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: The `icalbuddy-calendar.sh` template + contract tests

**Files:**
- Create: `assets/source-handlers/icalbuddy-calendar.sh`
- Test: extend `tests/extensions/dome.sources/handler.test.ts` (a sibling describe to `"the shipped claude-calendar.sh template"` at ~L347 — READ that describe first and mirror its harness exactly: how it stubs the fetch, how it runs stages, what it asserts)

**Interfaces:**
- Consumes: the handler contract and scaffolding structure of `assets/source-handlers/claude-calendar.sh` (L1-167): `set -eu`, `d="$1" f="$2"`, `land()` with pathspec + `-c commit.gpgsign=false`, commit-only-retry block, `mkdir -p`, `tmp="$(mktemp)"` + `trap`, then FETCH → VALIDATE → LAND stages. Copy that scaffolding; the REPAIR stage is model-output-specific and is NOT needed (deterministic fetcher, no fences/preamble).
- Produces: a template whose FETCH stage is:

```sh
# ----- FETCH (deterministic; requires macOS Calendar access) ------------------
# icalBuddy reads Calendar.app (EventKit) — recurring events expand correctly.
# ICAL_CALENDARS: optional comma-separated include list (icalBuddy -ic) to
# scope to specific calendars (e.g. your work account) and keep
# Birthdays/US Holidays noise out. Empty = all calendars.
ICAL_CALENDARS="${ICAL_CALENDARS:-}"
ical_args=""
[ -n "$ICAL_CALENDARS" ] && ical_args="-ic $ICAL_CALENDARS"

{
  printf -- '---\ntype: calendar-day\ndate: %s\n---\n\n# Calendar %s\n\n' "$d" "$d"
  LC_ALL=C icalbuddy $ical_args \
    -npn -nc -b '- ' -nrd \
    -iep "datetime,title,attendees" -po "datetime,title,attendees" \
    -ps '| — |' -tf '%H:%M' -df '' \
    eventsFrom:"$d at 00:00" to:"$d at 23:59" \
  | awk '
      # icalBuddy emits: "- HH:MM - HH:MM — Title — attendee1, attendee2"
      # (separator from -ps). Normalize into the parseMeetingLine shape:
      #   "- HH:MM–HH:MM — Title (attendees: a, b)"
      # All-day events arrive with no leading time; pass them through as
      #   "- Title" (parser yields time: null).
      /^- / {
        line = substr($0, 3)
        n = split(line, parts, / — /)
        time = ""; title = ""; att = ""
        if (parts[1] ~ /^[0-9]{1,2}:[0-9]{2}/) {
          time = parts[1]; title = parts[2]; att = parts[3]
        } else {
          title = parts[1]; att = parts[2]
        }
        gsub(/ - /, "\xe2\x80\x93", time)   # "09:00 - 09:30" -> "09:00–09:30"
        gsub(/^ +| +$/, "", title)
        out = "- "
        if (time != "") out = out time " \xe2\x80\x94 "   # " — "
        out = out title
        if (att != "") out = out " (attendees: " att ")"
        print out
        next
      }
    '
} > "$tmp"
```

(The exact icalBuddy flags above are a STARTING POINT — icalBuddy 1.10.1 is installed at `/opt/homebrew/bin/icalbuddy`; verify each flag against `icalbuddy -h` / real output and adjust the awk to the actual emitted shape. What is NOT negotiable: the final output lines must parse via `parseMeetingLine`, all-day events must survive as title-only bullets, and the file writes even when the agenda is empty.)

- Also produces the VALIDATE stage (adapted from claude-calendar.sh's — first line `---`, contains `date: $d`, contains `# Calendar $d`) and the same LAND flow.

- [ ] **Step 1: Read the existing template + its tests.** `assets/source-handlers/claude-calendar.sh` in full, and the `"the shipped claude-calendar.sh template"` describe in `tests/extensions/dome.sources/handler.test.ts` (~L347+). Note exactly how those tests execute the script (env stubs? stage extraction? tmp git repos?).
- [ ] **Step 2: Write failing tests** as a sibling describe `"the shipped icalbuddy-calendar.sh template"` covering, in whatever harness style the existing describe uses:
  1. commit-only retry: `$f` exists → no fetch, one pathspec commit, exit 0;
  2. transform: given captured icalBuddy-style sample output (embed a fixture string with a timed meeting incl. attendees, a timed meeting without attendees, and an all-day event), the written file contains `- 09:00–09:30 — Standup (attendees: Alice, Bob)`-shaped lines, a title-only bullet for the all-day event, and the normative frontmatter/heading;
  3. empty agenda: zero events → file still written+committed with frontmatter+heading only, exit 0;
  4. validation gate: broken output (no frontmatter) → exit non-zero, nothing committed.
  For (2)-(4), stub the fetch the same way the existing tests stub `claude` — if they use PATH shims (a fake executable earlier in PATH), create a fake `icalbuddy` shim emitting the fixture; if they extract stages, do that.
- [ ] **Step 3: Run tests, verify they fail** (`bun test tests/extensions/dome.sources/handler.test.ts`): the new describe fails on missing file.
- [ ] **Step 4: Write the template** per the Interfaces block: claude-calendar.sh's scaffolding (header comment adapted — this one is THE deterministic daemon-safe default for macOS; keep the contract bullet list; add a short TCC note: on Calendar-access denial icalBuddy exits non-zero → outbox retry → health question; grant via System Settings → Privacy & Security → Calendars), FETCH as above (verified against real icalBuddy locally: run `icalbuddy -npn -nc -b '- ' -iep "datetime,title,attendees" -ps '| — |' -tf '%H:%M' -df '' eventsToday` yourself and align the awk), VALIDATE, LAND. Mark it executable (`chmod +x`), matching claude-calendar.sh's mode.
- [ ] **Step 5: Run tests green.** Same command. Also run `bun test tests/cli/commands/init.test.ts tests/cli/commands/recipe.test.ts` (init copies templates from `assets/source-handlers/` — if it asserts an exhaustive template list, update it; if `dome recipe` enumerates handlers, check `src/cli/commands/recipe.ts` — but do NOT add a new recipe kind; this template is not a recipe).
- [ ] **Step 6: Commit** — `git commit -m "feat(sources): icalbuddy-calendar.sh — deterministic macOS calendar fetch template"` + trailer.

---

### Task 2: Spec + recipe docs

**Files:**
- Modify: `docs/wiki/specs/sources.md` (~L130 the template paragraph, and §"Connector-backed fetch is foreground-only" item 2/3)
- Modify: `docs/wiki/specs/vault-layout.md` §"Populating the calendar file" (~L136-156)

**Interfaces:** Consumes Task 1's template name/behavior. Produces the normative pointer later readers follow.

- [ ] **Step 1: `sources.md`** — in the template paragraph (~L130): the SDK now ships TWO calendar fetch-command templates: `claude-calendar.sh` (connector-backed, foreground-only reference) and `icalbuddy-calendar.sh` (**the deterministic macOS default for daemon subscriptions**: EventKit via Calendar.app, recurring events handled, `ICAL_CALENDARS` include-list, empty-day file still written, TCC denial fails loud through the ordinary outbox path). In §"Connector-backed fetch is foreground-only" item 2, name the shipped template as the ready-made deterministic option instead of only listing raw tools. Keep the keep-owned-prose-current discipline: rewrite the sentences in place.
- [ ] **Step 2: `vault-layout.md`** §"Populating the calendar file": name `icalbuddy-calendar.sh` as the shipped deterministic path (copy to `.dome/bin/fetch-calendar.sh`, set `ICAL_CALENDARS`, flip `enabled: true`); demote the gcalcli sketch to the alternative it is. Add one sentence: an empty day-file means "known: no meetings" and is deliberately still written (vs. absent = unknown).
- [ ] **Step 3: Backlog note** — append to the design doc's Part D (docs/cohesive/brainstorms/2026-07-02-intake-close-design.md) is ALREADY done; instead verify the deterministic-Slack backlog sentence exists there (no edit if present).
- [ ] **Step 4: Commit** — `git commit -m "docs(specs): icalbuddy-calendar.sh is the deterministic macOS calendar path"` + trailer.

---

### Task 3: The AGENTS.md interface sentence

**Files:**
- Modify: `src/cli/commands/init-templates.ts` (the vault AGENTS.md template — find the "Vault conventions" section)
- Test: `tests/cli/commands/init.test.ts` (whichever test pins AGENTS.md template content)

**Interfaces:** Produces the templated sentence every vault gets on `dome init` / `--refresh-instructions`.

- [ ] **Step 1: Failing test.** In the init test that asserts AGENTS.md content (grep the file for `Vault conventions` or `AGENTS.md` assertions), add an assertion that the generated AGENTS.md contains the sentence below.
- [ ] **Step 2: Verify it fails.** `bun test tests/cli/commands/init.test.ts`
- [ ] **Step 3: Add to the "Vault conventions" bullet list** in the template (exact text):

```
- Context fetched interactively (Slack digests, live calendar) lands as
  `sources/<kind>/<date>.md` day-files, committed normally — the engine
  weaves whatever exists into the daily and omits what doesn't.
```

- [ ] **Step 4: Green + typecheck.** `bun test tests/cli/commands/init.test.ts && bun run typecheck`
- [ ] **Step 5: Commit** — `git commit -m "feat(init): teach the sources day-file interface in the vault AGENTS.md template"` + trailer.

---

### Task 4: Verification sweep

**Files:** none new.

- [ ] **Step 1:** `bun run typecheck` — clean (three projects).
- [ ] **Step 2:** `bun test tests/extensions/dome.sources tests/cli/commands tests/integration` — green except the KNOWN pre-existing failures if any resurface (none expected: main is green as of bf714f8). Any failure: re-run the file in isolation before diagnosing (parallel-load flake caveat).
- [ ] **Step 3:** `bun test ./tests` — full suite; report the tally.
- [ ] **Step 4: Commit** any lockstep fallout fixes if a fence names a doc to update (none expected — no manifest/schema changes in this plan).

---

## Post-merge operator steps (controller, NOT plan tasks)

Recorded so the executor knows they are deliberately absent from the tasks: (1) `/morning` personal skill at `~/.claude/skills/morning/SKILL.md` (client-side artifact); (2) work-vault rollout — copy template over `.dome/bin/fetch-calendar.sh`'s FETCH, set `ICAL_CALENDARS`, flip `calendar.enabled: true`, `dome init --refresh-instructions`, daemon restart, TCC probe; (3) acceptance waits on the owner adding the Google account to Calendar.app.

## Self-review notes (applied)

- Spec coverage: design Part A template → Task 1; Part A pruning → descoped (design records why); Part C sentence → Task 3; Part D docs → Task 2; Parts B + rollout → post-merge operator steps by design.
- No placeholders; the one deliberately-open item (exact icalBuddy flags) is bounded by a non-negotiable output contract and a local verification instruction, not left vague.
- Type consistency: no cross-task types; the only shared name is the template filename, used identically in Tasks 1-3.
