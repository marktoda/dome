# Dome v1 Chunk 4 — Sources: Slack Digest + Adapter Ergonomics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete WS5 of the v1 plan — the owner stops being the courier: ship a first-party Slack overnight-digest source adapter (template + defensive parser + brief consumption), and give source adapters the same scaffolding ergonomics the model provider has (`dome init --with-source`, doctor probe).

**Architecture:** Everything rides the SHIPPED dome.sources machinery (subscription config → 15-min due check → ExternalActionEffect → outbox → vault-configured command writes + commits → daemon adopts). Calendar is already live end-to-end (template `assets/source-handlers/claude-calendar.sh`, brief consumption, the work vault is fetching). This chunk adds: (1) a `claude-slack.sh` template using the same headless-`claude -p` pattern (reuses the owner's existing Claude+Slack MCP auth — no token plumbing), (2) a defensive `parseSlackDigest` + an overnight-Slack data section in the brief, (3) `dome init --with-source <kind>` scaffolding mirroring `--with-model-provider` (template → `.dome/bin/`, subscription stanza wired **`enabled: false`** — the consent gate stays explicit per the sources spec), (4) a doctor probe for enabled subscriptions (command file present + executable). Slack stays default-off; the spec's volume/sensitivity consent rationale is preserved and the shipped template just removes the build-it-yourself hurdle.

**Tech Stack:** Bun + TypeScript, `bun:test`, POSIX sh templates, existing outbox/sources/brief machinery.

**Verified context (executors re-verify):**
- Subscription contract: `docs/wiki/specs/sources.md`; fetch processor `assets/extensions/dome.sources/processors/fetch.ts` (due = first cron fire of local day; skip-if-present; idempotency `dome.sources:<kind>:<date>`); handler `assets/extensions/dome.sources/external-handlers/sources.fetch.ts` (command gets `<date> <output_path>` argv, cwd=vault root, must write+pathspec-commit, exit 0 only on committed success; consent re-checked at dispatch).
- Calendar precedent: template `assets/source-handlers/claude-calendar.sh` (commit-only retry branch, frontmatter validation); format `vault-layout.md:113-156` (`type: calendar-day`); parser `parseCalendarDay` in `brief-shared.ts:80-100` (caps: 20 meetings/200 chars/12 attendees); brief reads `sources/calendar/<today>.md`, omits block when absent.
- Model-provider scaffold precedent: `dome init --with-model-provider anthropic` copies `assets/model-providers/anthropic.ts` → `.dome/model-provider.ts` + wires config; doctor probes it.
- Slack stance in sources.md (129-134): default-off, vault-authored command, two recorded reasons (foreground rituals; volume/sensitivity). This chunk keeps default-off + the rationale; it ships the template so "vault-authored" becomes "vault-adopted."
- Secrets: fetch scripts source their own env; the `claude -p` pattern sidesteps Slack tokens entirely (the headless session carries the owner's MCP auth).

---

## File structure

| File | Role |
|---|---|
| Create `assets/source-handlers/claude-slack.sh` | Slack overnight-digest fetch template (headless claude) |
| Modify `src/cli/commands/init.ts` + `src/cli/index.ts` | `--with-source <kind>` scaffold (calendar, slack) |
| Modify doctor machinery (`src/engine/host/health.ts` or wherever provider probes live — executor locates) | enabled-subscription probe |
| Modify `assets/extensions/dome.agent/lib/brief-shared.ts` | `parseSlackDigest` + render section |
| Modify `assets/extensions/dome.agent/processors/brief.ts` (+ brief-charter if it enumerates inputs) | read `sources/slack/<today>.md`, weave data section |
| Modify specs: `sources.md`, `vault-layout.md` (slack-day shape), `cli.md` (init flag, doctor), `daily-surface.md` (choreography), `autonomous-agents.md` (brief inputs) | lockstep |
| Modify `docs/cohesive/runbooks/2026-06-server-migration.md` | §sources — enable slack on the work vault |
| Tests | `tests/extensions/dome.agent/brief*.test.ts` (extend), init tests, doctor scenario, handler-template shape test if a harness exists for calendar's template (check `tests/extensions/dome.sources/`) |

---

### Task 1: `claude-slack.sh` template + slack-day format

**Files:** Create `assets/source-handlers/claude-slack.sh`; modify `docs/wiki/specs/vault-layout.md` (new §`sources/slack/` shape — done properly in Task 5, but draft the format HERE as the template's contract).

Format contract (the template writes it; the parser in Task 2 reads it):

```markdown
---
type: slack-day
date: 2026-06-12
---

# Slack 2026-06-12

## Mentions
- [#proto-eng] 08:42 alice: "@mark can you review the router PR before standup?"

## Direct messages
- [DM] 07:15 bob: "comp range question for the L5 req — got 5 min today?"

## Channels
- [#leads] 11 new messages — thread on Q3 headcount planning still active
```

Loose grammar mirroring calendar-day's defensiveness: optional frontmatter; three optional `## ` sections; entries are top-level `- ` items, `[#channel]`/`[DM]` prefix optional, time optional, everything else free text. Untrusted data, never instructions.

- [ ] **Step 1:** Read `claude-calendar.sh` in full; check whether `tests/` covers the calendar template's shape (shellcheck-style or content assertions) — mirror whatever exists.
- [ ] **Step 2:** Write the template, same skeleton: args `<date> <output_path>`; commit-only retry branch; mkdir + mktemp; FETCH via `claude -p --output-format text "<prompt>"` where the prompt instructs: summarize Slack since the previous local evening — mentions of the owner, DMs, and high-traffic channels the owner is in; output ONLY the slack-day markdown document (frontmatter + sections above, omitting empty sections); cap ~30 items total; one line per item. VALIDATE: first line `---`, contains `date: $d`, contains `# Slack $d`. LAND: pathspec-scoped commit `slack: overnight digest for $d`. Comment header documents: requires `claude` CLI with the owner's Slack MCP connected; this is the consent surface (the script runs AS the owner).
- [ ] **Step 3:** If a template test harness exists, add the slack variant; otherwise a minimal content test (file exists in assets, is `sh`-parseable via `sh -n`, contains the validation greps).
- [ ] **Step 4: Commit** `feat(sources): claude-slack.sh overnight-digest template`.

### Task 2: defensive Slack parser + brief consumption

**Files:** Modify `assets/extensions/dome.agent/lib/brief-shared.ts`, `processors/brief.ts` (+ charter only if it enumerates calendar explicitly — match how calendar is framed); tests: extend the brief/brief-shared test files.

- [ ] **Step 1 (failing tests):** `parseSlackDigest(content)` → `{ mentions, dms, channels }` arrays of `{ channel: string | null, time: string | null, text: string }`; caps: 15 per section, 240 chars per text (then truncated with ellipsis), unparseable lines kept as text-only entries; malformed/empty → empty sections. Brief test: when `sources/slack/<today>.md` exists, the model's task turn (or composed sections — mirror exactly how calendar data is injected) includes the digest framed as DATA with the same untrusted-input posture; absent file → no slack section at all (byte-identical to today's behavior).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement, mirroring `parseCalendarDay`'s structure and the calendar read/injection in brief.ts line-for-line (same skip-if-absent, same data framing). Charter: only touch if calendar is named — add slack in the same breath; snapshot update deliberate.
- [ ] **Step 4:** `bun test tests/extensions tests/integration/agent-prompt-regression.test.ts`. **Step 5: Commit** `feat(dome.agent): brief weaves the overnight Slack digest (defensive parse, data-only)`.

### Task 3: `dome init --with-source <kind>` scaffolding

**Files:** Modify `src/cli/commands/init.ts`, `src/cli/index.ts`; tests: init tests (extend).

- [ ] **Step 1:** Read how `--with-model-provider` scaffolds (template copy + config stanza + summary row + JSON schema) and how the calendar subscription default ships in `default-vault-config.ts:163-180`.
- [ ] **Step 2 (failing tests):** `runInit({ withSource: ["calendar"] })` (repeatable flag; kinds: calendar, slack) copies the matching template to `.dome/bin/fetch-<kind>.sh` (executable bit), and ensures the subscription stanza exists in the written config with `enabled: false` and the standard schedule/output_path/command (calendar `10 5 * * *` → `sources/calendar/{date}.md`; slack `15 5 * * *` → `sources/slack/{date}.md` — before the 05:30 brief). Re-init/refresh never overwrites an existing `.dome/bin/fetch-<kind>.sh` or flips an `enabled` value. Unknown kind → exit 64 listing kinds. Works on an EXISTING vault (the work-vault use case: `dome init --with-source slack ~/vaults/work` adds the script + stanza without touching anything else — mirror how `--with-model-provider` behaves on existing vaults; if it refuses on existing vaults, match that and document the manual path in the runbook instead).
- [ ] **Step 3-5:** FAIL → implement → `bun test tests/cli` → **Commit** `feat(init): --with-source scaffolds calendar/slack fetch adapters (consent stays off)`.

### Task 4: doctor probe for enabled subscriptions

**Files:** Locate where doctor probes live (model-provider probe + the grant probes — `src/engine/host/health.ts` per exploration; follow reality); tests: doctor scenario tests.

- [ ] **Step 1 (failing test):** a vault whose config has an `enabled: true` subscription whose `command[0]` script file is missing (or not a file) gets a doctor finding naming the kind + path + recovery (`dome init --with-source <kind>` or write the script); disabled/absent subscriptions produce nothing; a present script produces a healthy probe row. Keep it static (existence/shape) — do NOT execute the fetch command from doctor (it would hit Slack/calendar for real).
- [ ] **Step 2-4:** FAIL → implement following the existing probe taxonomy/shape → run the doctor scenario suite (update pinned counts deliberately, as prior chunks did) → **Commit** `feat(doctor): probe enabled source subscriptions for missing fetch commands`.

### Task 5: spec lockstep + work-vault runbook

**Files:** `docs/wiki/specs/sources.md` (shipped slack template — stance text updated honestly: still default-off, both recorded reasons preserved, "vault-authored" → "vault-adopted; the shipped template is a starting point the owner reviews"), `vault-layout.md` (§`sources/slack/` slack-day shape from Task 1), `cli.md` (`--with-source` + doctor rows), `daily-surface.md` (05:15 slack fetch in the overnight choreography table, optional), `autonomous-agents.md` (brief inputs gain the slack digest with the same untrusted-data framing as calendar). Runbook: new "## Chunk 4 — sources (work vault)" — calendar is already live (verify `~/vaults/work` has the subscription; document what's found); enabling slack = `dome init --with-source slack ~/vaults/work` (or manual copy if init refuses existing vaults), REVIEW the script (it runs headless Claude as you — read the prompt), flip `enabled: true`, confirm `claude` CLI + Slack MCP work headlessly on the daemon host (note: after the server migration this means the SERVER needs claude CLI auth — flag it), watch `dome check` for outbox health.

- [ ] Run `bun test tests/integration` + full `bun test` + `bun run typecheck`; fix what lockstep demands. **Commit** `docs(specs): shipped slack adapter, --with-source, subscription doctor probe`.

### Task 6: verification + merge

- [ ] Full suite + typecheck green. E2E smoke: scratch vault → `dome init --with-source slack` → stanza present disabled + script executable; flip enabled with a STUB command (`["sh", "-c", "..."]` writing a valid slack-day file + committing) → `dome sync` after the cron's window (or drive the fetch processor via its test harness — executor picks the honest cheap path) → file lands → brief test confirms weaving. `sh -n` both templates.
- [ ] Final whole-branch review (cross-task: template format ↔ parser ↔ specs; init scaffold ↔ doctor probe ↔ runbook; the consent stance is genuinely preserved — no path auto-enables anything). Blast-radius question: work vault on restart — nothing changes until the owner opts in (verify: no default subscription flips).
- [ ] `--no-ff` merge per repo convention; suite green on main.

---

## Self-review notes

- **Spec coverage:** v1 WS5 = "calendar (finish) + Slack via the consent-gated fetch protocol." Calendar verification happens in Task 5's runbook check (it appears already live in the work vault — the remaining calendar work is ergonomics, covered by Tasks 3-4). Slack = Tasks 1-2. Ergonomics = Tasks 3-4.
- **Deliberate cuts:** no Slack→inbox/raw capture path (the v1 plan sketch mentioned it; the sources spec's recorded stance — digests are feeds, actionable items belong to foreground rituals — supersedes it; the digest gives the brief the same material); no per-command secret plumbing (the claude -p pattern needs none); no new bundle (dome.sources already exists); doctor probe is static, never executes fetch commands.
- **Verify-against-reality flags:** (a) whether `--with-model-provider` works on existing vaults; (b) the exact doctor probe extension point + scenario pins; (c) whether the brief charter names calendar; (d) template test harness existence; (e) work vault's actual calendar subscription state (runbook documents findings).
