// cli/commands/init: the `dome init [path]` command — Phase 11f hotfix.
//
// Per docs/wiki/specs/cli.md §"dome init" + docs/v1.md §"Vault" + §10.1,
// `dome init` initializes a vault with the minimum surface the engine
// needs to operate. The vault carries:
//
//   - `.git/`              — git repository
//   - `wiki/`              — markdown content
//   - `.dome/state/`       — derived sqlite databases (gitignored)
//   - `.dome/config.yaml`  — extension activation + grants
//   - `.gitignore`         — engine-managed
//   - `AGENTS.md`          — orientation surface
//   - `CLAUDE.md`          — Claude Code shim importing AGENTS.md
//
// The vault does NOT carry the first-party extension bundles
// (`dome.graph`, `dome.lint`, `dome.markdown`). They live with the SDK at
// `<SDK>/assets/extensions/` and are resolved at runtime by the bundle
// loader (`resolveShippedBundlesRoot` in `./sync-shared.ts`). This
// matches the v1.md model: "Core features are just built-in extensions"
// (§10.1) — built-in means shipped with the SDK, not copied into every
// vault.
//
// The scaffold steps:
//
//   1. Resolve target path (positional arg, else cwd).
//   2. Run `git init` if `<target>/.git/` doesn't exist.
//   3. Create dirs `<target>/wiki/` and `<target>/.dome/state/`.
//   4. Write `<target>/.dome/config.yaml` from a shipped default (below).
//   5. Write `<target>/.gitignore` (ignores `.dome/state/`).
//   6. Write `<target>/AGENTS.md` from the shipped orientation template.
//   7. Write `<target>/CLAUDE.md` as a small Claude Code shim.
//   8. If the repo has no commits yet, make an initial scaffold commit so
//      the adopted ref substrate has somewhere to start.
//
// Users wanting vault-local bundles (to override a shipped bundle or
// install a third-party one) create `<target>/.dome/extensions/<id>/`
// themselves and pass `--bundles-root <path>` to the CLI commands.
//
// Idempotency contract (re-running on an already-initialized vault must be
// a no-op):
//   - `git init` is already idempotent.
//   - Directory creation uses `mkdir({recursive: true})`.
//   - `config.yaml`: skip if exists.
//   - `.gitignore`: skip if exists.
//   - `AGENTS.md`: skip if exists. (Per
//     [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]], the file has a
//     user-prose section that survives the templated-section merge; first-
//     write-only matches that contract — the merge regenerates templated
//     sections on demand, today on `dome init` re-runs and in v1.x via the
//     reserved `dome doctor --repair` verb.)
//   - `CLAUDE.md`: skip if exists. Users may add local Claude-specific
//     notes below the shim; re-init must not clobber them.
//   - Initial scaffold commit: skip if HEAD already resolves.
//
// Exit codes per spec:
//   - 0 on success (including idempotent no-op re-runs).
//   - 1 on unexpected I/O failure.
//   - 64 (EX_USAGE) if the `path` arg is malformed (unused in v1.0 — any
//     non-empty string is accepted; tracked here for the future spec).

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { commit, currentSha, initRepo, isGitRepo } from "../../git";

import type { ParsedArgs } from "../args";

// ----- Internal types -------------------------------------------------------

/**
 * One-line audit trail of what `runInit` did (or skipped) for each step.
 * Module-private; the CLI prints these as a small block via `printSummary`.
 */
type StepOutcome = "created" | "skipped (already present)";

type InitSummary = {
  readonly vaultPath: string;
  readonly gitInit: StepOutcome;
  readonly wikiDir: StepOutcome;
  readonly stateDir: StepOutcome;
  readonly configYaml: StepOutcome;
  readonly gitignore: StepOutcome;
  readonly agentsMd: StepOutcome;
  readonly claudeMd: StepOutcome;
  readonly initialCommit: StepOutcome;
};

// ----- runInit --------------------------------------------------------------

/**
 * Execute `dome init`. Returns the exit code. On unexpected I/O failure,
 * surfaces the underlying message on stderr and returns 1; happy paths
 * (including idempotent re-runs) return 0.
 */
export async function runInit(args: ParsedArgs): Promise<number> {
  // 1. Resolve the target vault path.
  const target = args.positionals[0] ?? ".";
  const vaultPath = resolve(target);

  try {
    // Ensure the target dir itself exists (a `dome init ~/vaults/new` on a
    // non-existent path should create it, not error).
    await mkdir(vaultPath, { recursive: true });

    // 2. git init (idempotent — initRepo is a no-op when `.git/` exists).
    const gitAlreadyInit = await isGitRepo(vaultPath);
    if (!gitAlreadyInit) {
      await initRepo(vaultPath);
    }
    const gitInitOutcome: StepOutcome = gitAlreadyInit
      ? "skipped (already present)"
      : "created";

    // 3. Scaffold dirs. No `.dome/extensions/` here — the shipped
    //    first-party bundles live with the SDK and are resolved at
    //    runtime via `resolveShippedBundlesRoot`. A user installing a
    //    third-party bundle creates `<vault>/.dome/extensions/<id>/`
    //    themselves and passes `--bundles-root <path>` to the CLI.
    const wikiDir = join(vaultPath, "wiki");
    const stateDir = join(vaultPath, ".dome", "state");

    const wikiOutcome = await ensureDir(wikiDir);
    const stateOutcome = await ensureDir(stateDir);

    // 4. Write `.dome/config.yaml` (first-write-only).
    const configPath = join(vaultPath, ".dome", "config.yaml");
    const configOutcome = await writeIfMissing(configPath, DEFAULT_CONFIG_YAML);

    // 5. Write `.gitignore` so `.dome/state/` (derived operational
    //    state — sqlite databases, marker files) is never committed.
    //    Per vault-layout.md §"Git repository structure", the SDK is
    //    responsible for this file. First-write-only — if the user
    //    authored their own .gitignore we leave it alone.
    const gitignorePath = join(vaultPath, ".gitignore");
    const gitignoreOutcome = await writeIfMissing(gitignorePath, DEFAULT_GITIGNORE);

    // 6. Write `AGENTS.md` (first-write-only — preserves user-prose section
    //    across re-runs per AGENTS_MD_IS_ORIENTATION_SURFACE).
    const agentsPath = join(vaultPath, "AGENTS.md");
    const agentsOutcome = await writeIfMissing(agentsPath, AGENTS_MD_TEMPLATE);

    // 7. Write `CLAUDE.md`, the Claude Code auto-load shim. Claude Code
    //    reads CLAUDE.md, so it imports AGENTS.md where the full cross-
    //    harness orientation lives.
    const claudePath = join(vaultPath, "CLAUDE.md");
    const claudeOutcome = await writeIfMissing(claudePath, CLAUDE_MD_TEMPLATE);

    // 8. Initial scaffold commit, if the repo has no commits yet. The
    //    adopted-ref substrate needs HEAD to resolve before `dome sync`
    //    or `dome serve` can compute drift.
    const headExists = (await currentSha(vaultPath)) !== null;
    let initialCommitOutcome: StepOutcome;
    if (headExists) {
      initialCommitOutcome = "skipped (already present)";
    } else {
      // Stage `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and
      // `.dome/config.yaml`. Empty dirs (`wiki/`, `.dome/state/`) aren't
      // committable by git; they survive on disk for the user's first
      // write.
      await commit({
        path: vaultPath,
        message: INITIAL_COMMIT_MESSAGE,
        author: { name: "dome init", email: "dome-init@local" },
        files: [".gitignore", "AGENTS.md", "CLAUDE.md", ".dome/config.yaml"],
      });
      initialCommitOutcome = "created";
    }

    const summary: InitSummary = {
      vaultPath,
      gitInit: gitInitOutcome,
      wikiDir: wikiOutcome,
      stateDir: stateOutcome,
      configYaml: configOutcome,
      gitignore: gitignoreOutcome,
      agentsMd: agentsOutcome,
      claudeMd: claudeOutcome,
      initialCommit: initialCommitOutcome,
    };

    printSummary(summary);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome init: failed: ${msg}`);
    return 1;
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Create `dir` if absent, return whether the call did work. Errors
 * (permission denied, ENOSPC, etc.) propagate — `runInit`'s try/catch
 * surfaces them on stderr.
 */
async function ensureDir(dir: string): Promise<StepOutcome> {
  const existed = existsSync(dir);
  await mkdir(dir, { recursive: true });
  return existed ? "skipped (already present)" : "created";
}

/**
 * Write `content` to `path` only if the file does not already exist.
 * Returns whether the call did work. Idempotent on re-run; the existing
 * file is left untouched.
 */
async function writeIfMissing(path: string, content: string): Promise<StepOutcome> {
  if (existsSync(path)) return "skipped (already present)";
  await writeFile(path, content, "utf8");
  return "created";
}

/**
 * Print a small block summarizing what `dome init` did. One line per
 * step, "created" vs "skipped". The format is human-oriented; downstream
 * tooling that wants a structured shape can shell out to
 * `dome status --json` after init for the canonical state read.
 */
function printSummary(s: InitSummary): void {
  console.log(`dome init: initialized vault at ${s.vaultPath}`);
  console.log(`  git init:                ${s.gitInit}`);
  console.log(`  wiki/:                   ${s.wikiDir}`);
  console.log(`  .dome/state/:            ${s.stateDir}`);
  console.log(`  .dome/config.yaml:       ${s.configYaml}`);
  console.log(`  .gitignore:              ${s.gitignore}`);
  console.log(`  AGENTS.md:               ${s.agentsMd}`);
  console.log(`  CLAUDE.md:               ${s.claudeMd}`);
  console.log(`  initial commit:          ${s.initialCommit}`);
}

// ----- Templates ------------------------------------------------------------
//
// The default `.gitignore`, `.dome/config.yaml`, `AGENTS.md`, and
// `CLAUDE.md` content shipped into every new vault. Templates live in
// code (not under assets/) so the binary is self-contained and a future
// `bun build`-produced single-file CLI doesn't need to bundle a templates
// directory.

// The default `.gitignore` shipped into every new vault. Ignores
// `.dome/state/` per [[wiki/specs/vault-layout]] §"Derived operational
// state under .dome/state/" and a few common OS-metadata files.
const DEFAULT_GITIGNORE = `# Dome — derived operational state. Rebuildable from markdown + git.
.dome/state/

# OS metadata
.DS_Store
Thumbs.db
`;

const DEFAULT_CONFIG_YAML = `# Dome vault configuration (v1.0).
#
# This file controls which extensions are active and their capability
# grants. The shipped first-party bundles (\`dome.graph\`, \`dome.lint\`,
# \`dome.markdown\`) live with the SDK — the CLI's default
# \`--bundles-root\` resolves to the SDK's \`assets/extensions/\` directory.
# To install a third-party bundle,
# create \`.dome/extensions/<bundle-id>/\` here and pass
# \`--bundles-root .dome/extensions\` on the command line.

extensions:
  dome.lint:
    enabled: true
    # No capability grants needed — view-phase processor; reads are
    # implicitly allowed by the read.paths declaration in its manifest.

  dome.markdown:
    enabled: true
    # Markdown adoption processors read markdown and normalize frontmatter.
    grant:
      read:
        - "**/*.md"
      patch.auto:
        - "**/*.md"

  dome.graph:
    enabled: true
    grant:
      read:
        - "**/*.md"
      graph.write:
        - "dome.graph.*"

engine:
  # Maximum iterations of the fixed-point adoption loop per Proposal.
  # Hitting this cap is a programmer error (processors not idempotent
  # or in a patch-fight); surface diagnostic + block.
  max_iterations: 100

  # Auto-commit closure commits when adoption-phase processors emit
  # patches that converge. When false, processors that emit PatchEffect
  # are dropped (with a diagnostic). Default true for normal vaults.
  auto_commit_workflows: true

git:
  # Mirror of engine.auto_commit_workflows so workflow-commit.ts can
  # read it via EngineVault.config.git.auto_commit_workflows. Kept in
  # sync by the config-merge mechanism (today: dome init re-runs; v1.x:
  # the reserved \`dome doctor --repair\` verb) when both surfaces evolve.
  auto_commit_workflows: true
`;

// The AGENTS.md template — orientation surface for agentic harnesses. The
// delimiters `<!-- BEGIN user-prose -->` / `<!-- END user-prose -->` match
// the canonical strings pinned by
// [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] and the
// [[wiki/gotchas/agents-md-delimiter-shape]] lockstep contract — DO NOT
// edit them without updating the invariant doc + any future
// `src/agents-md.ts` parser.

const AGENTS_MD_TEMPLATE = `# This is a Dome vault.

This directory is a Git-backed markdown vault managed by Dome v1.0 (\`@dome/sdk\`).

## How writes work

You write markdown files normally — use your harness's native write tools
(\`Write\` / \`Edit\` in Claude Code, \`:w\` in vim, the OS file API in Obsidian).
Commit your changes to \`main\`:

\`\`\`bash
git add . && git commit -m "your message"
\`\`\`

**Commit per logical change.** The compiler host treats each commit as a Proposal —
one commit triggers one adoption cycle. Many small commits give you
per-change diagnostic feedback and a clean \`git blame\`; one mega-commit
bundles all diagnostics together and is harder to revert selectively. When
you finish a coherent unit of work (one entity updated, one source ingested,
one section rewritten), commit it.

For experimental work — a structural rewrite, a directory rename, a
many-pages refactor you might discard — use a git worktree to isolate it
from \`main\` until you're sure:

\`\`\`bash
git worktree add .Codex/worktrees/experiment-restructure -b experiment/restructure
cd .Codex/worktrees/experiment-restructure
# ...experimental edits + commits land on experiment/restructure...
# merge back to main when ready, or rm -rf and discard
\`\`\`

The compiler host watches \`refs/heads/main\` only, so worktree commits don't get
adopted until you merge them back. That's the point of using a worktree:
the experiment is invisible to the engine until you decide it's worth
keeping.

A compiler host (\`dome serve\`) watches for new commits. It can run in a
foreground terminal like an LSP/watch process or under a local background
service. On each commit, the engine runs adoption: lint markdown, validate
wikilinks, update projections, advance \`refs/dome/adopted/main\`. You see
nothing on the happy path. If a processor surfaces a warning, it lands in
the diagnostic projection.

If the compiler host isn't running, run \`dome sync\` once after your commits to
catch up.

## What you can ask the system

- \`dome status\` — what branch you're on, adopted ref, last sync time,
  pending runs.
- \`dome inspect diagnostics\` — broken wikilinks, lint warnings,
  unresolved questions.
- \`dome inspect runs\` — recent processor invocations + outcomes.
- \`dome inspect outbox\` — pending external actions.

## Vault conventions

- \`wiki/\` — your main markdown content. Pages link via \`[[wikilinks]]\`.
  Use bare names (\`[[danny]]\`) for vault-wide search; use paths
  (\`[[people/danny]]\`) for explicit references.
- \`.dome/extensions/\` — optional directory for vault-local third-party
  extension bundles. The shipped first-party bundles (\`dome.graph\`,
  \`dome.lint\`, \`dome.markdown\`) live with the SDK and don't need to be
  copied here.
  To install a third-party bundle, place its directory under
  \`.dome/extensions/<bundle-id>/\` and pass
  \`--bundles-root .dome/extensions\` to the CLI commands.
- \`.dome/state/\` — SQLite databases for projections, outbox, and run
  ledger. Don't edit by hand; projection state is rebuildable via \`dome rebuild\`.
- \`.dome/config.yaml\` — extension activation and engine config.

## Invariants you should know about

- **Markdown is the source of truth.** Anything in \`.dome/state/\` is
  derived and rebuildable from the git history + the projection-store
  cache keys.
- **The engine is the only thing that applies effects.** Processors
  return Effects; the engine routes them. No processor mutates state
  directly.
- **Every processor run is ledgered.** Even failed runs leave a row in
  \`.dome/state/runs.db\` for forensics.
- **Engine commits carry four \`Dome-*\` trailers.** \`git log --grep="Dome-Run:"\`
  yields the engine history; reverting an engine commit is safe.

<!-- BEGIN user-prose -->

## Your own notes about this vault

(Anything you add between the BEGIN / END user-prose delimiters above
and below survives Dome's templated-section regeneration. The templated
sections above the delimiter are regenerated by Dome when the AGENTS.md
template merge runs — today on \`dome init\` re-runs, in v1.x via the
reserved \`dome doctor --repair\` verb.)

<!-- END user-prose -->
`;

const CLAUDE_MD_TEMPLATE = `@AGENTS.md

## Claude Code

Use the Dome vault workflow described in AGENTS.md. Edit markdown normally,
commit coherent changes with git, and use \`dome status\`, \`dome sync\`, and
\`dome inspect <subject>\` only when the user wants adoption status or recovery
details.
`;

const INITIAL_COMMIT_MESSAGE = `dome init: initial scaffold

Includes:
- AGENTS.md (orientation surface for Claude Code and other harnesses)
- CLAUDE.md (Claude Code shim importing AGENTS.md)
- .gitignore (ignores .dome/state/)
- .dome/config.yaml (extension activation + engine settings)

The first-party extension bundles (dome.graph, dome.lint, dome.markdown)
live with the SDK at <SDK>/assets/extensions/ and are resolved at runtime
— the vault doesn't carry copies.

Generated by \`dome init\` v1.0
`;
