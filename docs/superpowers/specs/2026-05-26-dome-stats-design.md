# `dome stats` — Design

**Date:** 2026-05-26
**Status:** Approved (pending user spec review)

## Goal

Add an 8th CLI command, `dome stats`, that opens the current vault and prints a visually appealing, fun-to-glance-at dashboard summarizing the vault's structure and recent activity. Read-only, deterministic, no LLM. A future `dome stats graph` subcommand will add a knowledge-graph visualization; v1 ships only the dashboard.

## Why this command exists

Dome's existing CLI surface tells you *whether the vault is structurally valid* (`doctor`), but not *what's in it* at a glance. A summary view sits in a real gap: it's not "chat with the brain" (use a harness) and not "browse the vault" (use Obsidian) — it's a snapshot of structural state, the way `git log --oneline | head` is a snapshot of history.

The dogfooded `docs/wiki/specs/cli.md` spec says "**Seven commands**". Adding `stats` makes it eight. The spec is updated as part of this work; the *philosophy* (no browse, no chat) holds — a dashboard is neither.

## Surface

```
dome stats                    # pretty dashboard to stdout (default)
dome stats --json             # JSON to stdout, no colors, suppresses dashboard
dome stats --vault <path>     # override CWD vault detection (mirrors `serve`)
```

**Exit codes:**

- `0` — success
- `1` — vault open failed (no `.dome/` found in CWD or `--vault` path)
- `2` — usage error (unknown flag, etc.)

**Color/TTY behavior:** picocolors auto-detects `NO_COLOR`, `FORCE_COLOR`, and non-TTY stdout. `--json` always disables colors.

## Rendered layout (default mode)

```
  DOME · /Users/mark/vaults/dome-design
  ─────────────────────────────────────────
   127 pages  ·  42 entities  ·  18 concepts
   8 specs    ·  13 invariants  ·  6 matrices

  Wikilinks  ▓▓▓▓▓▓▓▓▓▓░░  843 links · 12 orphans
  Raw files  ▓▓▓▓▓░░░░░░░  31 sources · 2.4 MB
  Log        ▓▓▓▓▓▓▓▓▓▓▓▓  214 entries · last: 2h ago

  Top hubs:  claude-code (18) · dome-v0.5 (14) · vault (11)
  Vault age: 14 days · 9 commits · 3 contributors
```

Stylistic conventions:

- Title (`DOME`) bold cyan; vault path dim.
- Headline numbers bold yellow.
- Bars: filled `▓` colored per row (green for wikilinks, yellow for raw, cyan for log), unfilled `░` dim.
- Dividers (`─`) dim gray.
- Field labels plain weight.
- Bars are 12 cells wide, **visual texture only** — the precise count appears after them. The layout is fixed-width; terminal narrower than ~70 cols will wrap. Adapting to terminal width is out of scope for v1.

The top three lines of "page counts" show the four default types + a second row of the most-common extension types in the current vault (picked by count). Empty types are omitted from the headline; the rest collapse into a `… +N more types` footer line if any remain. (Edge case for vaults with many custom extensions.)

## What gets computed

| Stat | Source | Notes |
|---|---|---|
| Page counts by type | walk `wiki/<plural>/*.md`, group by directory via `singularOf` | Survives custom page-type extensions declared in `.dome/page-types.yaml`. |
| Total wikilinks | `parseWikilinks` per page, sum | Counts every link occurrence, not unique links. |
| Orphan wikilinks | full-path links whose target file doesn't exist | Same predicate `doctor` already uses for check 3. |
| Raw files: count + bytes | walk `raw/`, sum `stat().size` | Bytes rendered with KB/MB/GB suffix. |
| Notes files: count | walk `notes/` if it exists | Reported only if non-zero. |
| Log entries | parse `## [<ts>]` headings in `log.md` | Same regex `doctor` already uses for check 7. |
| Last-write age | most recent `## [<ts>]` heading | Rendered as "Nm ago" / "Nh ago" / "Nd ago". |
| Top hubs | `Map<targetPath, incomingCount>` built during walk; sorted desc | Top 5 retained in `VaultStats.topHubs`; dashboard displays the first 3, `--json` carries all 5. |
| Vault age | first git commit's commit date (not author date) | Days since first commit. `null` if no commits (impossible after `dome init` but typed for safety). |
| Commit count | `isomorphic-git` `log` length on HEAD | All commits on the current branch's history. |
| Contributors | distinct author emails across commits | Falls back to author name if email missing. |

## Code structure

```
src/cli/commands/stats.ts            # new — collect + render + orchestrate
src/cli/cli.ts                       # +1 .command("stats")
package.json                         # + "picocolors": "^1.0.1"
docs/wiki/specs/cli.md               # add §"dome stats", bump "Seven" → "Eight"
tests/cli/stats.test.ts              # new
```

`src/cli/commands/stats.ts` exports four functions:

```ts
// Pure data shape — also the JSON output schema.
export interface VaultStats {
  vaultPath: string;
  pageCounts: Record<string, number>;     // keyed by page-type singular (e.g., "entity")
  totalPages: number;
  wikilinks: { total: number; orphans: number };
  raw: { count: number; bytes: number };
  notes: { count: number };
  log: { entries: number; lastWriteAt: string | null }; // ISO-8601 or null
  topHubs: Array<{ target: string; incoming: number }>;
  git: { ageDays: number | null; commits: number; contributors: number };
}

// Pure: walks fs + git, no rendering. The seam tests assert on.
export async function collectStats(vault: Vault): Promise<VaultStats>;

// Pure: VaultStats → ANSI-decorated multi-line string.
export function renderDashboard(stats: VaultStats): string;

// Pure: VaultStats → JSON string (pretty-printed).
export function renderJson(stats: VaultStats): string;

// Orchestrator: openVault → collectStats → renderDashboard | renderJson.
export async function domeStats(
  vaultPath: string,
  opts: { json?: boolean },
): Promise<Result<{ output: string }, ToolError>>;
```

**Why this split:**

- `collectStats` is the seam for tests and for `--json`. Both renderers consume its output. JSON output equals this struct serialized — no second source of truth.
- Renderers are pure (no I/O), trivially testable.
- The orchestrator handles the failure path (vault open) and returns `Result<..., ToolError>` matching every other `dome*` command.
- `openVault` is invoked exactly once; `collectStats` takes a `Vault`, not a path, so tests can construct a `Vault` directly.

**Coupling to `doctor`:** intentionally none. Both walk `wiki/` and call `parseWikilinks`; the existing `walkMd` helper in `vault-fs.ts` is shared. Doctor accumulates violations as strings; stats accumulates counts. The shapes diverge enough that factoring out a shared "wiki walker" would cost more than the duplication saves. Revisit if a third consumer appears.

## CLI wiring (`src/cli/cli.ts`)

```ts
program
  .command("stats")
  .description("Print a visual dashboard of the vault's structure and activity.")
  .option("--vault <path>", "Vault path (defaults to current directory)")
  .option("--json", "Emit JSON to stdout (no colors, no dashboard)")
  .addHelpText("after", /* layout examples + JSON schema reference */)
  .action(async (opts: { vault?: string; json?: boolean }) => {
    const path = opts.vault ?? process.cwd();
    const r = await domeStats(path, { json: opts.json === true });
    if (!r.ok) { console.error(renderCliError(r.error)); outcome.code = ExitCode.Failure; return; }
    console.log(r.value.output);
  });
```

Help text added to the top-level program's `Examples:` block:

```
dome stats                          # dashboard for current vault
dome stats --json | jq .totalPages  # machine-readable
```

## Spec updates

`docs/wiki/specs/cli.md`:

1. Headline change: "**Seven commands**" → "**Eight commands**".
2. New section `## dome stats` inserted between `## dome doctor` and `## dome export-context` (alphabetical-by-purpose grouping; deterministic-side-door cluster).
3. The "no browse, no chat" philosophy paragraph is preserved verbatim and explicitly reconciled: stats is a snapshot, not navigation.

The dogfooded vault auto-updates its index/log via existing hooks when the spec file changes — no manual log entry needed.

## Testing

`tests/cli/stats.test.ts`:

1. **Counts** — Fixture vault from `domeInit` + a handful of `writeFile`s into `wiki/entities/`, `wiki/concepts/`, `raw/`. Assert `collectStats` returns the expected `pageCounts`, `totalPages`, `wikilinks.total`, `wikilinks.orphans`, `raw.count`, `raw.bytes`.
2. **Top hubs** — Two pages link to a common third page; assert it appears at `topHubs[0]` with `incoming: 2`.
3. **Last-write age formatting** — Synthesize a `log.md` with a known recent timestamp; assert the rendered dashboard contains "ago" and a plausible window.
4. **Render targets** — `renderDashboard(stats)` stripped of ANSI (regex `/\x1b\[[^m]*m/g`) contains "DOME", "pages", and the page-count numerals. Targeted token assertions, not a full snapshot (snapshots brittle against layout tweaks).
5. **JSON round-trip** — `JSON.parse(renderJson(stats))` deep-equals `stats`.
6. **CLI integration** — `runCli(["stats", "--vault", path, "--json"])` returns `ExitCode.Success`; captured stdout parses as JSON.
7. **Empty vault** — Fresh `dome init`'d vault; assert no crashes, `totalPages: 0`, `log.entries: 1` (the bootstrap entry from init), `git.commits: 1`.
8. **Color suppression** — `renderDashboard` invoked with `FORCE_COLOR=0` produces no ANSI escapes.

Tests follow the `domeInit`-based fixture pattern from `tests/cli/doctor-checks.test.ts` rather than `makeTestVault`, because stats reads git history and needs a real commit.

## Open questions

None. Decisions made during brainstorming:

- **Stats flavor:** Full dashboard (counts + activity + hubs + git), confirmed.
- **Visual style:** Colorful + Unicode via `picocolors` dep, confirmed.
- **JSON mode:** Yes (`--json` flag), confirmed.
- **Knowledge graph viz:** Out of scope for v1; design leaves room for `dome stats graph` subcommand.

## Out of scope (deferred)

- Knowledge-graph visualization (`dome stats graph`) — future.
- `--since <duration>` for time-windowed activity slices — future, only if asked for.
- Per-page-type drilldown (`dome stats entities`) — future.
- Watching mode (`--watch`) — speculative, no demand.
- Comparing two timestamps ("you added 14 pages this week") — future, requires log parsing past the headline timestamp.
