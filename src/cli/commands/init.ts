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
//     The refresh path replaces managed orientation text while preserving the
//     managed user-prose block. If an old orientation file has no delimiters,
//     the old content is moved into the new user-prose block.
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
import { basename, join, resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { commit, currentSha, initRepo, isGitRepo } from "../../git";
import {
  type DefaultModelProvider,
  defaultModelProviderConfig,
  defaultConfigRecord,
  defaultConfigYaml,
} from "../default-vault-config";
import { formatJson } from "../format";
import {
  bullets,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
} from "../presenter";

// ----- Internal types -------------------------------------------------------

export type RunInitOptions = {
  readonly path?: string | undefined;
  readonly refreshConfig?: boolean | undefined;
  readonly refreshInstructions?: boolean | undefined;
  readonly modelProvider?: DefaultModelProvider | undefined;
  readonly json?: boolean | undefined;
};

/**
 * One-line audit trail of what `runInit` did (or skipped) for each step.
 * Module-private; the CLI prints these as a small block via `printSummary`.
 */
type StepOutcome =
  | "created"
  | "updated"
  | "skipped (already present)"
  | "skipped (not requested)";

type InitSummary = {
  readonly vaultPath: string;
  readonly gitInit: StepOutcome;
  readonly wikiDir: StepOutcome;
  readonly notesDir: StepOutcome;
  readonly inboxRawDir: StepOutcome;
  readonly inboxProcessedDir: StepOutcome;
  readonly stateDir: StepOutcome;
  readonly configYaml: StepOutcome;
  readonly modelProvider: StepOutcome;
  readonly gitignore: StepOutcome;
  readonly agentsMd: StepOutcome;
  readonly claudeMd: StepOutcome;
  readonly initialCommit: StepOutcome;
};

type InitJsonResult =
  | {
      readonly schema: "dome.init/v1";
      readonly status: "initialized";
      readonly vault: string;
      readonly steps: {
        readonly git_init: StepOutcome;
        readonly wiki_dir: StepOutcome;
        readonly notes_dir: StepOutcome;
        readonly inbox_raw_dir: StepOutcome;
        readonly inbox_processed_dir: StepOutcome;
        readonly state_dir: StepOutcome;
        readonly config_yaml: StepOutcome;
        readonly model_provider: StepOutcome;
        readonly gitignore: StepOutcome;
        readonly agents_md: StepOutcome;
        readonly claude_md: StepOutcome;
        readonly initial_commit: StepOutcome;
      };
    }
  | {
      readonly schema: "dome.init/v1";
      readonly status: "error";
      readonly vault: string;
      readonly error: string;
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
      modelProvider: options.modelProvider,
    });

    const modelProviderOutcome = await ensureModelProvider({
      vaultPath,
      configPath,
      provider: options.modelProvider,
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
        files: initialCommitFiles(options.modelProvider),
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
      modelProvider: modelProviderOutcome,
      gitignore: gitignoreOutcome,
      agentsMd: agentsOutcome,
      claudeMd: claudeOutcome,
      initialCommit: initialCommitOutcome,
    };

    printSummary(summary, options.json === true);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (options.json === true) {
      console.log(formatJson({
        schema: "dome.init/v1",
        status: "error",
        vault: vaultPath,
        error: msg,
      } satisfies InitJsonResult));
    } else {
      console.error(`dome init: failed: ${msg}`);
    }
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
  readonly modelProvider?: DefaultModelProvider | undefined;
}): Promise<StepOutcome> {
  if (!existsSync(opts.path)) {
    await writeFile(
      opts.path,
      defaultConfigYaml({ modelProvider: opts.modelProvider }),
      "utf8",
    );
    return "created";
  }
  if (!opts.refresh) return "skipped (already present)";

  const body = await readFile(opts.path, "utf8");
  const root = recordFromYaml(parseYaml(body));
  if (root === null) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  const defaults = defaultConfigRecord();

  const changed = refreshFirstPartyDefaultConfig(root, defaults);
  if (!changed) return "skipped (already present)";
  await writeFile(opts.path, stringifyYaml(root), "utf8");
  return "updated";
}

async function ensureModelProvider(opts: {
  readonly vaultPath: string;
  readonly configPath: string;
  readonly provider?: DefaultModelProvider | undefined;
}): Promise<StepOutcome> {
  if (opts.provider === undefined) return "skipped (not requested)";

  const providerPath = join(opts.vaultPath, ".dome", "model-provider.ts");
  const fileOutcome = await writeIfMissing(
    providerPath,
    modelProviderTemplate(opts.provider),
  );
  const configOutcome = await ensureModelProviderConfig({
    path: opts.configPath,
    provider: opts.provider,
  });
  return summarizeProviderOutcomes([fileOutcome, configOutcome]);
}

async function ensureModelProviderConfig(opts: {
  readonly path: string;
  readonly provider: DefaultModelProvider;
}): Promise<StepOutcome> {
  const body = await readFile(opts.path, "utf8");
  const root = recordFromYaml(parseYaml(body));
  if (root === null) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  if (recordFromYaml(root.model_provider) !== null) {
    return "skipped (already present)";
  }
  root.model_provider = defaultModelProviderConfig(opts.provider);
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
  const next = refreshAgentsMd(body);
  if (next === body) return "skipped (already present)";
  await writeFile(opts.path, next, "utf8");
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

function refreshAgentsMd(body: string): string {
  return renderAgentsMd(userProseSectionFromExistingAgents(body));
}

function userProseSectionFromExistingAgents(body: string): string {
  const managed = extractManagedUserProseSection(body);
  if (managed !== null) return managed;
  const trimmed = body.trim();
  if (trimmed.length === 0) return USER_PROSE_SECTION;
  return `${USER_PROSE_BEGIN}

## Previous vault-specific instructions

${trimmed}

${USER_PROSE_END}
`;
}

function extractManagedUserProseSection(body: string): string | null {
  const begin = body.indexOf(USER_PROSE_BEGIN);
  if (begin < 0) return null;
  const end = body.indexOf(USER_PROSE_END, begin + USER_PROSE_BEGIN.length);
  if (end < 0) return null;
  return body.slice(begin, end + USER_PROSE_END.length).trimEnd() + "\n";
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

function modelProviderTemplate(provider: DefaultModelProvider): string {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_MODEL_PROVIDER_TEMPLATE;
  }
  const _exhaustive: never = provider;
  return _exhaustive;
}

function summarizeProviderOutcomes(
  outcomes: ReadonlyArray<StepOutcome>,
): StepOutcome {
  if (outcomes.includes("updated")) return "updated";
  if (outcomes.includes("created")) return "created";
  return "skipped (already present)";
}

function initialCommitFiles(
  provider: DefaultModelProvider | undefined,
): ReadonlyArray<string> {
  const files = [".gitignore", "AGENTS.md", "CLAUDE.md", ".dome/config.yaml"];
  if (provider !== undefined) files.push(".dome/model-provider.ts");
  return files;
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
function printSummary(s: InitSummary, json: boolean): void {
  if (json) {
    console.log(formatJson(summaryToJson(s)));
    return;
  }
  const caps = resolveCaps();
  const lines: string[] = [
    headline({ cmd: "init", context: basename(s.vaultPath) }, { tone: "ok", label: "vault ready" }, caps),
  ];
  lines.push(
    ...section("Vault", kv([{ label: "path", value: s.vaultPath, tone: "muted" }], caps), caps),
  );
  const steps = initStepRows(s);
  lines.push(...section("Created", bullets(steps.created, caps, "none"), caps));
  lines.push(...section("Updated", bullets(steps.updated, caps, "none"), caps));
  lines.push(...section("Already Present", bullets(steps.alreadyPresent, caps, "none"), caps));
  lines.push(...section("Skipped", bullets(steps.skipped, caps, "none"), caps));
  lines.push(...footer({ tone: "ok", label: "vault ready" }, caps));
  console.log(lines.join("\n"));
}

function initStepRows(s: InitSummary): {
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly alreadyPresent: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
} {
  const groups = {
    created: [] as string[],
    updated: [] as string[],
    alreadyPresent: [] as string[],
    skipped: [] as string[],
  };
  for (const [label, outcome] of [
    ["git repo", s.gitInit],
    ["wiki/", s.wikiDir],
    ["notes/", s.notesDir],
    ["inbox/raw/", s.inboxRawDir],
    ["inbox/processed/", s.inboxProcessedDir],
    [".dome/state/", s.stateDir],
    [".dome/config.yaml", s.configYaml],
    [".dome/model-provider.ts", s.modelProvider],
    [".gitignore", s.gitignore],
    ["AGENTS.md", s.agentsMd],
    ["CLAUDE.md", s.claudeMd],
    ["initial commit", s.initialCommit],
  ] as const) {
    if (outcome === "created") groups.created.push(label);
    else if (outcome === "updated") groups.updated.push(label);
    else if (outcome === "skipped (already present)") {
      groups.alreadyPresent.push(label);
    } else {
      groups.skipped.push(label);
    }
  }
  return Object.freeze({
    created: Object.freeze(groups.created),
    updated: Object.freeze(groups.updated),
    alreadyPresent: Object.freeze(groups.alreadyPresent),
    skipped: Object.freeze(groups.skipped),
  });
}

function summaryToJson(s: InitSummary): InitJsonResult {
  return {
    schema: "dome.init/v1",
    status: "initialized",
    vault: s.vaultPath,
    steps: {
      git_init: s.gitInit,
      wiki_dir: s.wikiDir,
      notes_dir: s.notesDir,
      inbox_raw_dir: s.inboxRawDir,
      inbox_processed_dir: s.inboxProcessedDir,
      state_dir: s.stateDir,
      config_yaml: s.configYaml,
      model_provider: s.modelProvider,
      gitignore: s.gitignore,
      agents_md: s.agentsMd,
      claude_md: s.claudeMd,
      initial_commit: s.initialCommit,
    },
  };
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
template merge runs. Re-run \`dome init --refresh-instructions\` to refresh
managed orientation while preserving this block.)

${USER_PROSE_END}
`;

const AGENTS_MD_TEMPLATE = renderAgentsMd(USER_PROSE_SECTION);

function renderAgentsMd(userProseSection: string): string {
  return `# This is a Dome vault.

This directory is a git-backed markdown vault managed by Dome. Claude Code can
work here using normal file, search, shell, and git tools; Dome watches committed
changes and compiles them into adopted vault state.

## Daily loop

1. Talk with the user and edit markdown normally.
2. Keep changes in ordinary vault files, usually under \`wiki/\`.
3. Commit each coherent unit of work with git.
4. At session start, run \`dome status --json\` and read \`serve_status\`. If it
   is \`off\`, use \`dome sync --json\` after commits unless the user starts a
   foreground \`dome serve\` host in another terminal/session.
5. If \`dome serve\` is running, let it adopt commits in the background.
6. If the user wants to wait for Dome, run \`dome sync --json\`.
7. Run \`dome status --json\` at session boundaries or when Dome reports
   attention. Follow its \`next_actions\`.

Good commit shape:

\`\`\`bash
git add .
git commit -m "describe the vault change"
\`\`\`

## Dome commands

Primary compiler commands:

- \`dome serve\` - keep the local compiler host running.
- \`dome sync --json\` - run one compiler tick now; use this when the user wants
  to wait for adoption or the host was off.
- \`dome status --json\` - fast vault pulse. Read \`attention_required\`,
  \`attention\`, and \`next_actions\`.
- \`dome check --json\` - unified read-only explanation for remaining attention:
  engine health, content diagnostics, and open decisions.
- \`dome resolve <id> <value>\` - resolve a Dome-raised decision from
  \`dome check\`.

Optional adopted-state views:

- \`dome query <text>\` - search adopted markdown and related extracted facts.
- \`dome export-context <topic>\` - portable source-backed context packet for
  another Claude session or review.

## Read-first context

For nontrivial vault work, use Dome's adopted-state views before broad manual
file hunting:

- Start with \`dome export-context <topic> --json\` when preparing a handoff,
  review, planning pass, or multi-file edit.
- Use \`dome query <text> --json\` for focused recall or when the context packet
  looks too broad.
- For daily planning, meeting prep, or person/topic follow-up, prefer a
  natural-language \`dome export-context <topic> --json\` or
  \`dome query <text> --json\` request. The daily note should already be
  prepared in markdown by Dome's background loop.

Treat these as read-first surfaces, not mandatory ceremony. If a packet misses
obvious context or returns noisy results, note the miss in the relevant markdown
or tell the user; that feedback is V1 dogfood evidence.

Advanced/debug commands:

- \`dome inspect <subject>\`, \`dome doctor\`, \`dome lint\`, \`dome answer\`,
  \`dome run\`, \`dome rebuild\`, and hidden compatibility daily views remain
  available for debugging, compatibility, and extension development, but they
  are not the normal Claude Code workflow.
- Useful inspect subjects are \`bundles\`, \`processors\`, \`runs\`, \`patches\`,
  \`facts\`, \`diagnostics\`, \`questions\`, \`outbox\`, and \`quarantine\`.

Do not call Dome after every edit. Dome works at the git commit boundary.

## Reading Dome status

\`dome status --json\` exposes \`serve_status\`, \`attention_required\`, stable
\`attention\` reason codes, and \`next_actions\`. Treat \`next_actions\` as the
canonical branch for compiler attention. In normal use:

- If \`serve_status\` is \`off\`, no foreground host is adopting commits in the
  background. Use \`dome sync --json\` after commits, or ask the user to start
  \`dome serve\` for a foreground compiler host.
- Run \`dome sync --json\` when status says the compiler needs to catch up.
- Run the \`dome check ...\` command in \`next_actions\` when status says
  attention remains after sync.
- Run \`dome resolve <id> <value>\` only after a Dome question is clear and
  source-grounded.
- Commit, ignore, or remove dirty draft files before expecting Dome to adopt
  them.

## Resolving Dome questions

\`dome check --json\` decision rows include \`automation_policy\` plus optional
\`risk\`, \`confidence\`, \`recommended_answer\`, and \`owner_needed_reason\`
fields.

- \`agent-safe\` / \`model-safe\`: a vault-aware agent may resolve the question
  without interrupting the user when the answer is grounded in the listed
  \`sourceRefs\`, current vault context, and one of the allowed options. Treat
  \`recommended_answer\` as a hint, not authority.
- \`owner-needed\` or missing policy: do not guess. Surface the question and the
  owner-needed reason, then keep unrelated vault work moving.
- Always answer through \`dome resolve <id> <value>\`. Do not edit
  \`.dome/state/\` or use \`dome answer\` in the normal workflow.

## Vault conventions

- \`wiki/\` is the main markdown knowledge base. Pages can link with
  \`[[wikilinks]]\`.
- \`notes/\` is available for loose markdown notes that do not yet belong in a
  wiki page.
- \`inbox/raw/\` is the raw capture drop-zone for committed captures when
  \`dome.intake\` is enabled and model-ready. Before using it, run
  \`dome inspect bundles --json\` and check the \`dome.intake\` row reports
  \`status: "enabled"\` and \`model: "ready"\`. Until then, keep management
  notes directly under \`wiki/\` or \`notes/\`.
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

${userProseSection}
`;
}

const CLAUDE_MD_TEMPLATE = `@AGENTS.md

## Claude Code

Use the Dome vault workflow in AGENTS.md. Edit markdown normally, commit
coherent changes with git, and use Dome commands when the user asks to wait for
adoption, explain compiler attention, resolve a Dome-raised decision, or render
an explicit source-backed vault view. For nontrivial vault work, read a
\`dome export-context <topic> --json\` packet or focused
\`dome query <text> --json\` result before broad manual file hunting.

The normal command path is \`dome status --json\` -> \`next_actions\` ->
\`dome sync --json\`, the suggested \`dome check ...\` command (often
\`dome check --json\`), or \`dome resolve <id> <value>\`. Resolve
\`agent-safe\` / \`model-safe\` questions only when the answer is grounded in
source refs; surface \`owner-needed\` questions instead of guessing.
`;

const ANTHROPIC_MODEL_PROVIDER_TEMPLATE = `#!/usr/bin/env bun
//
// Dome command model provider for Anthropic Messages API.
//
// Dome invokes this script with a JSON request on stdin:
// { "schema": "dome.model-provider.request/v1", "prompt": "...", ... }
// The script writes JSON on stdout:
// { "text": "...", "model": "...", "costUsd"?: number }
//
// Required environment:
// - ANTHROPIC_API_KEY
//
// Optional environment:
// - ANTHROPIC_MODEL (default: claude-haiku-4-5-20251001)
// - ANTHROPIC_MAX_TOKENS (default: 4096)
// - ANTHROPIC_INPUT_COST_PER_MTOK / ANTHROPIC_OUTPUT_COST_PER_MTOK
//   If both prices are set, Dome receives costUsd for budget accounting.

type ProviderRequest = {
  readonly schema: "dome.model-provider.request/v1";
  readonly prompt: string;
  readonly model?: string;
  readonly temperature?: number;
};

type AnthropicTextBlock = {
  readonly type: "text";
  readonly text: string;
};

type AnthropicResponse = {
  readonly content?: ReadonlyArray<AnthropicTextBlock | { readonly type: string }>;
  readonly model?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
};

const API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = positiveIntegerEnv("ANTHROPIC_MAX_TOKENS", 4096);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  if (API_KEY === undefined || API_KEY.trim().length === 0) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  const request = parseRequest(await Bun.stdin.text());
  const model = request.model ?? DEFAULT_MODEL;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: request.temperature ?? 0,
      messages: [{ role: "user", content: request.prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      \`Anthropic request failed \${response.status}: \${body.slice(0, 1000)}\`,
    );
  }

  const parsed = (await response.json()) as AnthropicResponse;
  const text = textFromAnthropicResponse(parsed);
  if (text.length === 0) {
    throw new Error("Anthropic response did not include a text block");
  }

  const costUsd = costFromUsage(parsed.usage);
  process.stdout.write(
    JSON.stringify({
      text,
      model: parsed.model ?? model,
      ...(costUsd === undefined ? {} : { costUsd }),
    }),
  );
}

function parseRequest(raw: string): ProviderRequest {
  const parsed = JSON.parse(raw) as Partial<ProviderRequest>;
  if (parsed.schema !== "dome.model-provider.request/v1") {
    throw new Error("unsupported Dome model provider request schema");
  }
  if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
    throw new Error("request.prompt must be a non-empty string");
  }
  if (parsed.model !== undefined && typeof parsed.model !== "string") {
    throw new Error("request.model must be a string when present");
  }
  if (
    parsed.temperature !== undefined &&
    (typeof parsed.temperature !== "number" || !Number.isFinite(parsed.temperature))
  ) {
    throw new Error("request.temperature must be a finite number when present");
  }
  return {
    schema: parsed.schema,
    prompt: parsed.prompt,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.temperature !== undefined
      ? { temperature: parsed.temperature }
      : {}),
  };
}

function textFromAnthropicResponse(response: AnthropicResponse): string {
  return (response.content ?? [])
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\\n")
    .trim();
}

function costFromUsage(
  usage: AnthropicResponse["usage"],
): number | undefined {
  const inputCost = numberEnv("ANTHROPIC_INPUT_COST_PER_MTOK");
  const outputCost = numberEnv("ANTHROPIC_OUTPUT_COST_PER_MTOK");
  if (
    usage === undefined ||
    inputCost === undefined ||
    outputCost === undefined ||
    usage.input_tokens === undefined ||
    usage.output_tokens === undefined
  ) {
    return undefined;
  }
  return (
    (usage.input_tokens / 1_000_000) * inputCost +
    (usage.output_tokens / 1_000_000) * outputCost
  );
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(\`\${name} must be a non-negative number\`);
  }
  return parsed;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(\`\${name} must be a positive integer\`);
  }
  return parsed;
}
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
