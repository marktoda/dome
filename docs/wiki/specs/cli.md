---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# CLI

This spec is normative for the `dome` command-line interface in v0.5. The CLI is the side-door surface — for things neither a chat-shaped harness nor a markdown-shaped browser does well: setup, migration, hook reconciliation, scheduled hygiene, diagnostics, cross-AI context export.

The CLI is intentionally small. **Seven commands**. Each maps to a concrete user action; commands that would map to "chat-with-the-brain" or "browse-the-vault" do not exist (use a harness or Obsidian respectively).

## `dome init <path>`

Bootstrap a new vault at `<path>`. Minimal and general-purpose — no profiles, no opt-in features activated beyond the shipped-default tier.

```bash
dome init ~/vaults/research
```

Creates:

- The directory tree: `raw/`, `notes/`, `wiki/{entities,concepts,sources,syntheses}/`, `inbox/raw/` (the shipped-default capture bucket), `.dome/{prompts,hooks,in-flight,state}/`.
- `.dome/page-types.yaml` with the four default types.
- `.dome/config.yaml` with tier-2 defaults enabled and tier-3 features disabled.
- `.dome/hooks/intake-raw.yaml` — the shipped-default intake hook that processes `inbox/raw/*` via the `ingest` workflow.
- `.gitignore` — excludes `.dome/in-flight/`, `.dome/state/`, `.dome/cache/`.
- `index.md` and `log.md` (with one bootstrap entry).
- A `CLAUDE.md` template at vault root the user can copy to their Claude Code config.
- **Initializes a git repository** and makes the initial commit (per [[wiki/invariants/VAULT_IS_GIT_REPO]]). The commit message: `chore: initialize Dome vault`. The user starts with a clean working tree and a vault that's immediately ready for use.

Refuses if `<path>` already contains `.dome/` (use `dome migrate` for existing Dome vaults) OR `.git/` with prior history that wasn't created by `dome init` (the user should `dome migrate` instead to inherit their existing history cleanly).

Activating tier-3 features beyond `intake-raw` (sensitivity routing, voice intake, research intake, clip intake) is manual after init: copy hook templates from the SDK's `hooks/templates/` into `.dome/hooks/` and create any additional `inbox/<bucket>/` directories. A future "packs" mechanism may layer convenience over this; v0.5 keeps activation explicit.

## `dome migrate <path>`

Convert an existing markdown vault (Obsidian / Foam / plain markdown / a previous-version Dome vault) to current Dome shape.

```bash
dome migrate ~/vaults/work
```

The migration is **a workflow** (`migrate` is a named workflow prompt; see [[wiki/specs/prompts-and-workflows]]). The headless agent loop:

1. Scans the directory; identifies probable categories (raw vs wiki vs notes).
2. Detects existing typed-page layout if present.
3. Proposes a migration plan: which files move, which frontmatter to add, which invariants would be violated and how to fix.
4. Writes the proposal to `<path>/.dome/migration-plan.md` for user review.
5. On user confirmation (`dome migrate <path> --apply`), executes the plan via Dome's Tools — every move and frontmatter add is logged.

This is the v0.5 sleeper feature: the on-ramp that lets users (the author first, others later) bring an existing vault into Dome without a forklift rewrite. Mass-market v1+ depends on this being good.

## `dome serve --vault <path>`

Start the MCP server (and the intake-hook watcher daemon) for `<path>`.

```bash
dome serve --vault ~/vaults/work          # stdio, default
dome serve --vault ~/vaults/work --port 7777   # HTTP/SSE (v0.5.1+)
```

The serve command, in order:

1. Opens the vault, loads the registry.
2. **Runs `dome reconcile` automatically** to catch up on any events missed while serve wasn't running (in-flight hooks from a crash, pending inbox files, out-of-band edits, missed scheduled events). See `dome reconcile` below.
3. Starts the MCP server on stdio (or HTTP if `--port` is given).
4. Starts the file watcher on `inbox/*/` directories and `wiki/*/` (for out-of-band-edit detection); declarative-hook intakes fire on file writes.
5. Starts the clock source for scheduled hooks.
6. Runs until killed.

If the auto-reconcile at step 2 fails (e.g., vault is mid-merge — see [[wiki/gotchas/dirty-git-state-at-reconcile]]), serve refuses to start with a clear error.

For Claude Code integration, the harness spawns `dome serve --vault $VAULT` as a child process. For user-facing background operation (intake watching, scheduled lint), the user runs `dome serve` as a launchd / systemd service. v0.5 documents the setup pattern; v1+ may ship a service installer.

## `dome reconcile`

Catch up the vault's hook execution state to match the current filesystem state. Run automatically by `dome serve` at startup; can be invoked manually when serve isn't running or after an out-of-band sync (e.g., `git pull`).

```bash
cd ~/vaults/work && dome reconcile
```

Runs four phases in order (see [[wiki/specs/hooks]] §"Durability and reconciliation" for full detail):

1. **In-flight recovery** — re-fire events for any lockfiles in `.dome/in-flight/`.
2. **Inbox processing** — fire `document.written.inbox.<bucket>` for each file in `inbox/<bucket>/`. Intake hooks move the files out on completion (per [[wiki/invariants/INBOX_IS_EPHEMERAL]]).
3. **Git diff** — fire `document.written.<category>.<type>` for each file changed since `.dome/state/last-reconciled-sha.txt`, using `git status --porcelain` + `git diff --name-only`.
4. **Scheduled catch-up** — fire `clock.tick.<interval>` for each scheduled hook whose interval has elapsed.

Refuses to run if the vault is mid-merge, mid-rebase, or mid-cherry-pick — see [[wiki/gotchas/dirty-git-state-at-reconcile]] for the detection and the recovery path.

Exit codes: 0 on success; nonzero if reconciliation could not complete (dirty git state, missing `.git/`, corrupted state files). Output: a summary of the events fired and hooks completed per phase.

## `dome lint`

Run the `lint` workflow against the vault.

```bash
cd ~/vaults/work && dome lint
```

Invokes the `lint` workflow prompt via the headless agent loop:

- Reads the wiki and index.
- Detects: orphan pages, stale claims, missing cross-references, contradictions, schema-violating frontmatter, out-of-band direct edits.
- Writes proposed fixes to `wiki/inbox/lint-pass-YYYY-MM-DD.md` (or `inbox/review/`).
- Exits 0 on success; nonzero if drift was found above a configurable threshold.

Designed to be cron'd weekly. The vault is git-backed, so applying proposed fixes is safe (`git revert` is available).

## `dome doctor`

Diagnose the vault's structural health.

```bash
cd ~/vaults/work && dome doctor
```

Unlike `dome lint` (semantic / agent-driven), `dome doctor` is deterministic: it walks the vault and reports structural violations:

- Pages whose `type:` frontmatter doesn't match their directory.
- Pages with frontmatter fields not in the page-type schema.
- Wikilinks that don't resolve.
- Wikilinks not in full-path form.
- Pages in `wiki/<unknown-subdir>/`.
- Raw files modified after creation (suggests something bypassed `RAW_IS_IMMUTABLE`).
- `log.md` non-monotonic timestamps.
- `.dome/page-types.yaml` declares extensions not used; or pages use types not declared.

Exit 0 if clean; nonzero with a report otherwise. Suggests fixes; doesn't apply them. Run after `dome migrate` to verify; run before opening to a new harness to verify upstream changes didn't drift.

## `dome export-context <topic>`

Produce a markdown context-packet for cross-AI handoff.

```bash
cd ~/vaults/work && dome export-context "platform team ownership"
```

Invokes the `export-context` workflow:

- Identifies relevant pages by topic.
- Reads their content.
- Composes a markdown blob with sections (entities involved, current synthesis, open questions, related decisions, source trail).
- Writes to stdout (pipeable) or to a named file with `--out <path>`.

This is the antidote to pinned-thread chaos: paste the output into ChatGPT / Cursor / a new Claude Code session and resume thinking with full context. Particularly useful when switching AI tools mid-task.

## What's not a CLI command

| Action | Why no CLI | Use this instead |
|---|---|---|
| `dome capture <text>` | Quick capture IS just a write to `inbox/raw/<ts>.md`; the intake hook does the rest. No special Dome command needed. | `echo "$THOUGHT" > $VAULT/inbox/raw/$(date -u +%Y%m%d-%H%M%S).md` |
| `dome chat` | Chat surface lives in the harness (Claude Code). Dome is the layer beneath. | `claude` (in a vault directory with Dome MCP configured) |
| `dome browse` | Browsing markdown is what Obsidian / vim / any editor does well. | Obsidian on the vault path |
| `dome query <q>` | Query lives in a chat harness. CLI version would just shell out to the same workflow. | Ask in your harness |
| `dome import-obsidian` | Subsumed by `dome migrate` (auto-detects Obsidian structure) | `dome migrate` |
| `dome backup` | Vault is git-backed; backup is `git push`. | `cd $VAULT && git push` |

## Implementation note

CLI commands implement to a single pattern: parse args, open the vault, dispatch to either (a) a Tool sequence (deterministic: `init`, `doctor`, `serve`, `reconcile`) or (b) a workflow via the headless agent loop (LLM-driven: `migrate`, `lint`, `export-context`). The CLI itself is < 600 LOC; most of the work lives in the workflows and Tools.

The 7 commands map cleanly to user actions:

| Command | Kind | When the user reaches for it |
|---|---|---|
| `dome init` | deterministic | First setup of a new vault |
| `dome migrate` | workflow | Adopting Dome for an existing markdown vault |
| `dome serve` | deterministic (with auto-reconcile at startup) | Running the MCP server + intake watcher (typically a launchd / systemd service) |
| `dome reconcile` | deterministic | Catching up after `dome serve` was off (intakes pending, out-of-band edits, missed schedules) |
| `dome lint` | workflow | Periodic vault hygiene (weekly cron or manual) |
| `dome doctor` | deterministic | Diagnostic structural check (no LLM) |
| `dome export-context` | workflow | Cross-AI handoff (paste context into ChatGPT / Cursor / etc.) |

## Related

- [[wiki/specs/sdk-surface]] — the Tools the CLI dispatches against.
- [[wiki/specs/mcp-surface]] — `dome serve` starts this.
- [[wiki/specs/prompts-and-workflows]] — workflows invoked by `migrate`, `lint`, `export-context`.
- [[wiki/specs/harnesses]] — `dome serve` is what harnesses connect to.
