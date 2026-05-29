// cli/commands/init: the `dome init [path]` command — Phase 11f hotfix.
//
// Per docs/wiki/specs/cli.md §"dome init" + docs/v1.md §"Vault" + §10.1,
// `dome init` initializes a vault with the minimum surface the engine
// needs to operate. The vault carries:
//
//   - `.git/`              — git repository
//   - `wiki/`              — markdown content
//   - `notes/`             — loose markdown notes
//   - `inbox/raw/`         — raw capture drop-zone when dome.intake is enabled
//   - `inbox/processed/`   — processed capture archive target
//   - `.dome/state/`       — derived sqlite databases (gitignored)
//   - `.dome/config.yaml`  — extension activation + grants
//   - `.gitignore`         — engine-managed
//   - `AGENTS.md`          — orientation surface
//   - `CLAUDE.md`          — Claude Code shim importing AGENTS.md
//
// The vault does NOT carry the first-party extension bundles
// (`dome.daily`, `dome.graph`, `dome.health`, `dome.intake`, `dome.lint`,
// `dome.markdown`, `dome.search`). They live with the SDK at
// `<SDK>/assets/extensions/` and are
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
//   3. Create dirs `<target>/wiki/`, `<target>/notes/`,
//      `<target>/inbox/raw/`, `<target>/inbox/processed/`, and
//      `<target>/.dome/state/`.
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
//   - `config.yaml`: skip if exists, unless `--refresh-config` is set. That
//     opt-in path adds missing first-party default bundle stanzas and fills
//     missing default grant keys for enabled first-party bundles without
//     changing existing grant values or re-enabling explicitly disabled
//     bundles.
//   - `.gitignore`: skip if exists.
//   - `AGENTS.md`: skip if exists, unless `--refresh-instructions` is set.
//     The refresh path adds the managed user-prose delimiter if an old
//     orientation file is missing it.
//   - `CLAUDE.md`: skip if exists, unless `--refresh-instructions` is set.
//     The refresh path adds the `@AGENTS.md` import shim if an old Claude
//     memory file is missing it, preserving the old content below.
//   - Initial scaffold commit: skip if HEAD already resolves.
//
// Exit codes per spec:
//   - 0 on success (including idempotent no-op re-runs).
//   - 1 on unexpected I/O failure.
//   - 64 (EX_USAGE) if the `path` arg is malformed (unused in v1.0 — any
//     non-empty string is accepted; tracked here for the future spec).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { commit, currentSha, initRepo, isGitRepo } from "../../git";

// ----- Internal types -------------------------------------------------------

export type RunInitOptions = {
  readonly path?: string | undefined;
  readonly refreshConfig?: boolean | undefined;
  readonly refreshInstructions?: boolean | undefined;
};

/**
 * One-line audit trail of what `runInit` did (or skipped) for each step.
 * Module-private; the CLI prints these as a small block via `printSummary`.
 */
type StepOutcome = "created" | "updated" | "skipped (already present)";

type InitSummary = {
  readonly vaultPath: string;
  readonly gitInit: StepOutcome;
  readonly wikiDir: StepOutcome;
  readonly notesDir: StepOutcome;
  readonly inboxRawDir: StepOutcome;
  readonly inboxProcessedDir: StepOutcome;
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
    const notesDir = join(vaultPath, "notes");
    const inboxRawDir = join(vaultPath, "inbox", "raw");
    const inboxProcessedDir = join(vaultPath, "inbox", "processed");
    const stateDir = join(vaultPath, ".dome", "state");

    const wikiOutcome = await ensureDir(wikiDir);
    const notesOutcome = await ensureDir(notesDir);
    const inboxRawOutcome = await ensureDir(inboxRawDir);
    const inboxProcessedOutcome = await ensureDir(inboxProcessedDir);
    const stateOutcome = await ensureDir(stateDir);

    // 4. Write `.dome/config.yaml` (first-write-only by default). Existing
    //    vaults may explicitly opt into reconciling missing first-party
    //    default bundle stanzas and grant keys with `--refresh-config`.
    const configPath = join(vaultPath, ".dome", "config.yaml");
    const configOutcome = await ensureConfigYaml({
      path: configPath,
      refresh: options.refreshConfig === true,
    });

    // 5. Write `.gitignore` so `.dome/state/` (derived operational
    //    state — sqlite databases, marker files) is never committed.
    //    Per vault-layout.md §"Git repository structure", the SDK is
    //    responsible for this file. First-write-only — if the user
    //    authored their own .gitignore we leave it alone.
    const gitignorePath = join(vaultPath, ".gitignore");
    const gitignoreOutcome = await writeIfMissing(gitignorePath, DEFAULT_GITIGNORE);

    // 6. Write `AGENTS.md` (first-write-only by default; explicit refresh
    //    repairs old orientation files without dropping user prose).
    const agentsPath = join(vaultPath, "AGENTS.md");
    const agentsOutcome = await ensureAgentsMd({
      path: agentsPath,
      refresh: options.refreshInstructions === true,
    });

    // 7. Write `CLAUDE.md`, the Claude Code auto-load shim. Claude Code
    //    reads CLAUDE.md, so it imports AGENTS.md where the full cross-
    //    harness orientation lives.
    const claudePath = join(vaultPath, "CLAUDE.md");
    const claudeOutcome = await ensureClaudeMd({
      path: claudePath,
      refresh: options.refreshInstructions === true,
    });

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
      notesDir: notesOutcome,
      inboxRawDir: inboxRawOutcome,
      inboxProcessedDir: inboxProcessedOutcome,
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

async function ensureConfigYaml(opts: {
  readonly path: string;
  readonly refresh: boolean;
}): Promise<StepOutcome> {
  if (!existsSync(opts.path)) {
    await writeFile(opts.path, DEFAULT_CONFIG_YAML, "utf8");
    return "created";
  }
  if (!opts.refresh) return "skipped (already present)";

  const body = await readFile(opts.path, "utf8");
  const root = recordFromYaml(parseYaml(body));
  if (root === null) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  const defaults = recordFromYaml(parseYaml(DEFAULT_CONFIG_YAML));
  if (defaults === null) {
    throw new Error("internal default config template is not a YAML mapping");
  }

  const changed = refreshFirstPartyDefaultConfig(root, defaults);
  if (!changed) return "skipped (already present)";
  await writeFile(opts.path, stringifyYaml(root), "utf8");
  return "updated";
}

async function ensureAgentsMd(opts: {
  readonly path: string;
  readonly refresh: boolean;
}): Promise<StepOutcome> {
  if (!existsSync(opts.path)) {
    await writeFile(opts.path, AGENTS_MD_TEMPLATE, "utf8");
    return "created";
  }
  if (!opts.refresh) return "skipped (already present)";

  const body = await readFile(opts.path, "utf8");
  if (hasManagedUserProseDelimiters(body)) {
    return "skipped (already present)";
  }
  await writeFile(
    opts.path,
    body.trimEnd() + "\n\n" + USER_PROSE_SECTION,
    "utf8",
  );
  return "updated";
}

async function ensureClaudeMd(opts: {
  readonly path: string;
  readonly refresh: boolean;
}): Promise<StepOutcome> {
  if (!existsSync(opts.path)) {
    await writeFile(opts.path, CLAUDE_MD_TEMPLATE, "utf8");
    return "created";
  }
  if (!opts.refresh) return "skipped (already present)";

  const body = await readFile(opts.path, "utf8");
  if (body.includes("@AGENTS.md")) return "skipped (already present)";
  const next = body.trim().length === 0
    ? CLAUDE_MD_TEMPLATE
    : `@AGENTS.md\n\n${body.trimStart()}`;
  await writeFile(opts.path, next, "utf8");
  return "updated";
}

function hasManagedUserProseDelimiters(body: string): boolean {
  return body.includes(USER_PROSE_BEGIN) && body.includes(USER_PROSE_END);
}

function refreshFirstPartyDefaultConfig(
  root: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  const extensions = recordFromYaml(root.extensions);
  const defaultExtensions = recordFromYaml(defaults.extensions);
  if (extensions === null || defaultExtensions === null) return false;

  let changed = false;
  for (const extensionId of Object.keys(defaultExtensions).sort()) {
    const defaultExtension = recordFromYaml(defaultExtensions[extensionId]);
    if (defaultExtension === null) continue;
    if (!hasOwn(extensions, extensionId)) {
      extensions[extensionId] = cloneYamlValue(defaultExtension);
      changed = true;
      continue;
    }

    const extension = recordFromYaml(extensions[extensionId]);
    if (extension === null) continue;
    if (extension.enabled !== true) continue;

    const defaultGrant = grantRecord(defaultExtension);
    if (defaultGrant === null) continue;
    const grantKey = grantKeyFor(extension);
    const grant = grantRecord(extension) ?? {};
    if (!hasOwn(extension, grantKey)) {
      extension[grantKey] = grant;
      changed = true;
    }

    for (const key of Object.keys(defaultGrant).sort()) {
      if (hasOwn(grant, key)) continue;
      grant[key] = cloneYamlValue(defaultGrant[key]);
      changed = true;
    }
  }
  return changed;
}

function grantKeyFor(extension: Record<string, unknown>): "grant" | "grants" {
  return hasOwn(extension, "grants") && !hasOwn(extension, "grant")
    ? "grants"
    : "grant";
}

function grantRecord(
  extension: Record<string, unknown>,
): Record<string, unknown> | null {
  const raw = hasOwn(extension, "grant") ? extension.grant : extension.grants;
  return recordFromYaml(raw);
}

function cloneYamlValue(value: unknown): unknown {
  return structuredClone(value);
}

function recordFromYaml(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Print a small block summarizing what `dome init` did. One line per
 * step. The format is human-oriented; downstream
 * tooling that wants a structured shape can shell out to
 * `dome status --json` after init for the canonical state read.
 */
function printSummary(s: InitSummary): void {
  console.log(`dome init: initialized vault at ${s.vaultPath}`);
  console.log(`  git init:                ${s.gitInit}`);
  console.log(`  wiki/:                   ${s.wikiDir}`);
  console.log(`  notes/:                  ${s.notesDir}`);
  console.log(`  inbox/raw/:              ${s.inboxRawDir}`);
  console.log(`  inbox/processed/:        ${s.inboxProcessedDir}`);
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
# \`dome.health\`, \`dome.intake\`, \`dome.lint\`, \`dome.markdown\`,
# \`dome.search\`) live with the SDK — the
# CLI's default \`--bundles-root\` resolves to the SDK's \`assets/extensions/\`
# directory.
# To install a third-party bundle,
# create \`.dome/extensions/<bundle-id>/\` here and pass
# \`--bundles-root .dome/extensions\` on the command line.
#
# Model-capable bundles can use an injected host provider or a command
# provider configured here. The command runs with the vault root as cwd,
# receives a JSON request on stdin, and returns JSON on stdout:
#
# model_provider:
#   kind: command
#   command: ["bun", ".dome/model-provider.ts"]

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

  # Opt in when your Dome host injects or configures a ModelProvider. The
  # bundle compiles committed markdown captures from inbox/raw/*.md into
  # generated intake pages and processed archives.
  dome.intake:
    enabled: false
    grant:
      read:
        - "inbox/**/*.md"
        - "wiki/generated/intake/*.md"
      patch.auto:
        - "wiki/generated/intake/*.md"
        - "wiki/syntheses/intake-*.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
      graph.write:
        - "dome.intake.*"
      model.invoke:
        maxDailyCostUsd: 5
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

  # Optional global execution caps. Uncomment to bound processor manifest
  # requests more tightly for this vault.
  # processor_timeout_ms: 600000
  # model_call_timeout_ms: 180000

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

const USER_PROSE_BEGIN = "<!-- BEGIN user-prose -->";
const USER_PROSE_END = "<!-- END user-prose -->";
const USER_PROSE_SECTION = `${USER_PROSE_BEGIN}

## Your own notes about this vault

(Anything you add between the BEGIN / END user-prose delimiters above
and below survives Dome's templated-section regeneration. The templated
sections above the delimiter are regenerated by Dome when the AGENTS.md
template merge runs — today this file is first-write-only on \`dome init\`
re-runs, and v1.x reserves \`dome doctor --repair\` for future safe
template refresh.)

${USER_PROSE_END}
`;

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
- \`dome prep\` - source-backed planning packet for a day.
- \`dome agenda <person-or-topic>\` - source-backed prep for a person or topic.
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
- \`notes/\` is available for loose markdown notes that do not yet belong in a
  wiki page.
- \`inbox/raw/\` is the raw capture drop-zone for committed captures when
  \`dome.intake\` is enabled and a model provider is configured. Until then,
  keep management notes directly under \`wiki/\` or \`notes/\`.
- \`inbox/processed/\` is where \`dome.intake\` archives captures it has
  compiled into generated wiki material.
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

${USER_PROSE_SECTION}
`;

const CLAUDE_MD_TEMPLATE = `@AGENTS.md

## Claude Code

Use the Dome vault workflow in AGENTS.md. Edit markdown normally, commit
coherent changes with git, and use Dome commands when the user asks to wait for
adoption, inspect health/recovery state, or render a source-backed vault view.
The command list in AGENTS.md is the source of truth for \`dome status\`,
\`dome sync\`, \`dome today\`, \`dome prep\`, \`dome agenda\`, \`dome query\`,
\`dome export-context\`, and recovery commands such as
\`dome inspect <subject>\` / \`dome answer\`.
`;

const INITIAL_COMMIT_MESSAGE = `dome init: initial scaffold

Includes:
- AGENTS.md (orientation surface for Claude Code and other harnesses)
- CLAUDE.md (Claude Code shim importing AGENTS.md)
- .gitignore (ignores .dome/state/)
- .dome/config.yaml (extension activation + engine settings)

The first-party extension bundles (dome.daily, dome.graph, dome.health,
dome.intake, dome.lint, dome.markdown, dome.search) live with the SDK at
<SDK>/assets/extensions/ and
are resolved at runtime — the vault doesn't carry copies.

Generated by \`dome init\` v1.0
`;
