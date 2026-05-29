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
// (`dome.daily`, `dome.graph`, `dome.health`, `dome.lint`, `dome.markdown`,
// `dome.search`). They live with the SDK at `<SDK>/assets/extensions/` and are
// resolved at runtime by the bundle loader (`resolveShippedBundlesRoot` in
// `./sync-shared.ts`). This matches the v1.md model: "Core features are just
// built-in extensions"
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

// ----- Internal types -------------------------------------------------------

export type RunInitOptions = {
  readonly path?: string | undefined;
};

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
export async function runInit(options: RunInitOptions = {}): Promise<number> {
  // 1. Resolve the target vault path.
  const target = options.path ?? ".";
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
# grants. The shipped first-party bundles (\`dome.daily\`, \`dome.graph\`,
# \`dome.health\`, \`dome.lint\`, \`dome.markdown\`, \`dome.search\`) live with the SDK — the
# CLI's default \`--bundles-root\` resolves to the SDK's \`assets/extensions/\`
# directory.
# To install a third-party bundle,
# create \`.dome/extensions/<bundle-id>/\` here and pass
# \`--bundles-root .dome/extensions\` on the command line.

extensions:
  dome.lint:
    enabled: true
    grant:
      read:
        - "**/*.md"

  dome.markdown:
    enabled: true
    # Markdown adoption processors read markdown and normalize frontmatter.
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
        - "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"
      patch.auto:
        - "**/*.md"
      question.ask: true

  dome.graph:
    enabled: true
    grant:
      read:
        - "**/*.md"
      graph.write:
        - "dome.graph.*"

  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
      patch.auto:
        - "wiki/dailies/*.md"
      graph.write:
        - "dome.daily.*"
      question.ask: true

  dome.search:
    enabled: true
    grant:
      read:
        - "**/*.md"
      search.write:
        - "**/*.md"

  dome.health:
    enabled: true
    grant:
      read:
        - "**"
      outbox.read:
        - failed
      question.ask: true
      outbox.recover: true
      quarantine.read: true
      quarantine.recover: true
      run.read:
        - running
      run.recover: true

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
  # Mirror of engine.auto_commit_workflows so EngineVault.config can expose
  # the historical git-shaped flag to closure-commit code. When both keys
  # are present, they must agree.
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

This directory is a git-backed markdown vault managed by Dome. Claude Code can
work here using normal file, search, shell, and git tools; Dome watches committed
changes and compiles them into adopted vault state.

## Daily loop

1. Talk with the user and edit markdown normally.
2. Keep changes in ordinary vault files, usually under \`wiki/\`.
3. Commit each coherent unit of work with git.
4. If \`dome serve\` is running, let it adopt the commit in the background.
5. If the user wants to wait for Dome, run \`dome sync\`.
6. Use \`dome status\` or \`dome inspect <subject>\` only for health, adoption
   status, and recovery.

Good commit shape:

\`\`\`bash
git add .
git commit -m "describe the vault change"
\`\`\`

## Dome commands

- \`dome status\` - branch, HEAD, adopted ref, content counts, and health counts.
- \`dome sync\` - one-shot catch-up when no compiler host is running or when the
  user wants to wait for adoption.
- \`dome today\` - source-backed open tasks, followups, and questions for today.
- \`dome query <text>\` - search adopted markdown and related extracted facts.
- \`dome lint\` - adopted-state hygiene report over diagnostics and lint checks.
- \`dome export-context <topic>\` - portable source-backed context packet for
  another Claude session or review.
- \`dome inspect diagnostics\` - current markdown and engine diagnostics.
- \`dome inspect questions\` - open questions that need human input.
- \`dome answer <id> <value>\` - answer a question from \`dome inspect questions\`.
- \`dome inspect runs\` - recent processor runs and failures.
- \`dome inspect outbox\` - pending or failed external actions.
- \`dome rebuild\` - rebuild projection state from adopted markdown when recovery
  requires it.

Do not call Dome after every edit. Dome works at the git commit boundary.

## Vault conventions

- \`wiki/\` is the main markdown knowledge base. Pages can link with
  \`[[wikilinks]]\`.
- \`.dome/config.yaml\` controls enabled extension bundles and grants.
- \`.dome/state/\` contains derived SQLite state for projections, outbox, and the
  run ledger. Do not edit or commit it.
- \`.dome/extensions/\` is optional vault-local extension code. The shipped
  first-party bundles live with the SDK and do not need to be copied here.

## Load-bearing rules

- Markdown plus git history are the source of truth.
- Every trusted mutation goes through a Proposal and the adoption loop.
- Processors return Effects; the engine is the only applier.
- Every effect is capability-checked before it lands.
- Projection state is rebuildable from adopted markdown.
- Engine commits carry \`Dome-*\` trailers for auditability.

<!-- BEGIN user-prose -->

## Your own notes about this vault

(Anything you add between the BEGIN / END user-prose delimiters above
and below survives Dome's templated-section regeneration. The templated
sections above the delimiter are regenerated by Dome when the AGENTS.md
template merge runs — today this file is first-write-only on \`dome init\`
re-runs, and v1.x reserves \`dome doctor --repair\` for future safe
template refresh.)

<!-- END user-prose -->
`;

const CLAUDE_MD_TEMPLATE = `@AGENTS.md

## Claude Code

Use the Dome vault workflow in AGENTS.md. Edit markdown normally, commit
coherent changes with git, and only use \`dome status\`, \`dome sync\`, or
\`dome inspect <subject>\` when the user wants adoption status, recovery detail,
or an explicit health check.
`;

const INITIAL_COMMIT_MESSAGE = `dome init: initial scaffold

Includes:
- AGENTS.md (orientation surface for Claude Code and other harnesses)
- CLAUDE.md (Claude Code shim importing AGENTS.md)
- .gitignore (ignores .dome/state/)
- .dome/config.yaml (extension activation + engine settings)

The first-party extension bundles (dome.daily, dome.graph, dome.health,
dome.lint, dome.markdown, dome.search) live with the SDK at
<SDK>/assets/extensions/ and
are resolved at runtime — the vault doesn't carry copies.

Generated by \`dome init\` v1.0
`;
