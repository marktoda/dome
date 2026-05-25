---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# CLI

This spec is normative for the `dome` command-line interface in v0.5. The CLI is the side-door surface — for things neither a chat-shaped harness nor a markdown-shaped browser does well: setup, migration, scheduled hygiene, diagnostics, cross-AI context export.

The CLI is intentionally small. **Five commands**. Each maps to a concrete user action; commands that would map to "chat-with-the-brain" or "browse-the-vault" do not exist (use a harness or Obsidian respectively).

## `dome init <path>`

Bootstrap a new vault at `<path>`. Minimal and general-purpose — no profiles, no opt-in features activated.

```bash
dome init ~/vaults/research
```

Creates:

- The directory tree: `raw/`, `notes/`, `wiki/{entities,concepts,sources,syntheses}/`, `.dome/{prompts,hooks}/`. No `inbox/` (intakes are opt-in; users create the buckets they need).
- `.dome/page-types.yaml` with the four default types.
- `.dome/config.yaml` with tier-2 defaults enabled and tier-3 features disabled.
- `index.md` and `log.md` (with one bootstrap entry).
- A `CLAUDE.md` template at vault root the user can copy to their Claude Code config.

Refuses if `<path>` already contains `.dome/`. Use `dome migrate` for existing vaults.

Activating tier-3 features (sensitivity routing, voice intake, research intake, etc.) is manual after init: copy hook templates from the SDK's `hooks/templates/` into `.dome/hooks/` and create any `inbox/<bucket>/` directories the templates listen on. A future "packs" mechanism may layer convenience over this; v0.5 keeps activation explicit.

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

The serve command:

- Opens the vault, loads the registry.
- Starts the MCP server on stdio (or HTTP if `--port` is given).
- Starts the file watcher on `inbox/*/` directories; declarative-hook intakes fire on file writes.
- Starts the clock source for scheduled hooks.
- Runs until killed.

For Claude Code integration, the harness spawns `dome serve --vault $VAULT` as a child process; there is no long-running daemon by default. For user-facing background operation (intake watching, scheduled lint), the user may run `dome serve` as a launchd / systemd service. v0.5 does not ship a service installer; the docs show how to set one up.

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

CLI commands implement to a single pattern: parse args, open the vault, dispatch to either (a) a Tool sequence (deterministic: `init`, `doctor`, `serve`) or (b) a workflow via the headless agent loop (LLM-driven: `migrate`, `lint`, `export-context`). The CLI itself is < 500 LOC; most of the work lives in the workflows and Tools.

## Related

- [[wiki/specs/sdk-surface]] — the Tools the CLI dispatches against.
- [[wiki/specs/mcp-surface]] — `dome serve` starts this.
- [[wiki/specs/prompts-and-workflows]] — workflows invoked by `migrate`, `lint`, `export-context`.
- [[wiki/specs/harnesses]] — `dome serve` is what harnesses connect to.
