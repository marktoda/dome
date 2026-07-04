// cli/commands/init: the `dome init [path]` command — Phase 11f hotfix.
//
// Per docs/wiki/specs/cli.md §"dome init" + docs/v1.md §"Vault" + §10.1,
// `dome init` initializes a vault with the minimum surface the engine
// needs to operate. The vault carries:
//
//   - `.git/`              — git repository
//   - `wiki/`              — markdown content
//   - `notes/`             — loose markdown notes
//   - `inbox/raw/`         — raw capture drop-zone when dome.agent is enabled
//   - `inbox/processed/`   — processed capture archive target
//   - `.dome/state/`       — derived sqlite databases (gitignored)
//   - `.dome/config.yaml`  — extension activation + grants
//   - `.gitignore`         — engine-managed
//   - `core.md`            — always-loaded core memory page (commented skeleton)
//   - `preferences/signals.md` — append-only preference-signal log (commented header)
//   - `AGENTS.md`          — orientation surface
//   - `CLAUDE.md`          — Claude Code shim importing AGENTS.md
//
// The vault does NOT carry the first-party extension bundles
// (`dome.daily`, `dome.graph`, `dome.health`, `dome.agent`, `dome.lint`,
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
//   - `core.md`: skip if exists — never overwrite the user's core memory.
//   - `preferences/signals.md`: skip if exists — the signal log is
//     append-only owner data; init never overwrites it.
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

import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";

import { commit, currentSha, initRepo, isGitRepo } from "../../git";
import {
  type DefaultGrantValue,
  type DefaultModelProvider,
  type DefaultSourceKind,
  type FirstPartyExtensionDefault,
  FIRST_PARTY_EXTENSION_DEFAULTS,
  defaultModelProviderConfig,
  defaultConfigRecord,
  defaultConfigYaml,
  defaultSourceSubscription,
} from "../default-vault-config";
import { globMatch } from "../../engine/core/glob-cache";
import {
  parseManifest,
  type ManifestGrantEntryRequirement,
} from "../../extensions/manifest-schema";
import { formatJson } from "../../surface/format";
import {
  bullets,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
} from "../presenter";
import {
  resolveShippedBundlesRoot,
  resolveShippedModelProvidersRoot,
  resolveShippedSourceHandlersRoot,
} from "./sync-shared";
import {
  CLAUDE_MD_TEMPLATE,
  CORE_MD_TEMPLATE,
  DEFAULT_GITIGNORE,
  INITIAL_COMMIT_MESSAGE,
  SIGNALS_MD_TEMPLATE,
  renderAgentsMd,
} from "./init-templates";

// ----- Internal types -------------------------------------------------------

export type RunInitOptions = {
  readonly path?: string | undefined;
  readonly refreshConfig?: boolean | undefined;
  readonly refreshInstructions?: boolean | undefined;
  readonly modelProvider?: DefaultModelProvider | undefined;
  readonly withSource?: ReadonlyArray<DefaultSourceKind> | undefined;
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
  /** Grants/stanzas a `--refresh-config` merge added (empty otherwise). */
  readonly grantsAdded: ReadonlyArray<string>;
  readonly modelProvider: StepOutcome;
  readonly sources: StepOutcome;
  readonly gitignore: StepOutcome;
  readonly coreMd: StepOutcome;
  readonly signalsMd: StepOutcome;
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
        readonly sources: StepOutcome;
        readonly gitignore: StepOutcome;
        readonly core_md: StepOutcome;
        readonly signals_md: StepOutcome;
        readonly agents_md: StepOutcome;
        readonly claude_md: StepOutcome;
        readonly initial_commit: StepOutcome;
      };
      /** Grants/stanzas a `--refresh-config` merge added. */
      readonly grants_added: ReadonlyArray<string>;
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
    // Keep the inbox drop-zone + archive tracked in git even when empty: the
    // ingest agent empties `inbox/raw/` after each capture, and git does not
    // track empty directories. `.gitkeep` is a dotfile, so it matches neither
    // `inbox/raw/*.md` (ingest trigger) nor `inbox/**/*.md` (stale-check).
    await writeIfMissing(join(inboxRawDir, ".gitkeep"), "");
    await writeIfMissing(join(inboxProcessedDir, ".gitkeep"), "");
    const stateOutcome = await ensureDir(stateDir);

    // 4. Write `.dome/config.yaml` (first-write-only by default). Existing
    //    vaults may explicitly opt into reconciling missing first-party
    //    default bundle stanzas and grant keys with `--refresh-config`.
    const configPath = join(vaultPath, ".dome", "config.yaml");
    const sourceKinds = [...new Set(options.withSource ?? [])];
    const configResult = await ensureConfigYaml({
      path: configPath,
      refresh: options.refreshConfig === true,
      modelProvider: options.modelProvider,
      sources: sourceKinds,
    });

    const modelProviderOutcome = await ensureModelProvider({
      vaultPath,
      configPath,
      provider: options.modelProvider,
    });

    const sourcesOutcome = await ensureSources({
      vaultPath,
      configPath,
      kinds: sourceKinds,
    });

    // 5. Write `.gitignore` so `.dome/state/` (derived operational
    //    state — sqlite databases, marker files) is never committed.
    //    Per vault-layout.md §"Git repository structure", the SDK is
    //    responsible for this file. First-write-only — if the user
    //    authored their own .gitignore we leave it alone.
    const gitignorePath = join(vaultPath, ".gitignore");
    const gitignoreOutcome = await writeIfMissing(gitignorePath, DEFAULT_GITIGNORE);

    // 5b. Write `core.md`, the always-loaded core memory page, as a
    //     commented skeleton. First-write-only with NO refresh path — the
    //     page is the user's core memory; init never overwrites it. Per
    //     vault-layout.md §"core.md — the core memory page".
    const coreOutcome = await writeIfMissing(
      join(vaultPath, "core.md"),
      CORE_MD_TEMPLATE,
    );

    // 5c. Write `preferences/signals.md`, the append-only preference-signal
    //     log, as a commented header explaining the signal grammar. Like
    //     core.md it is owner data: first-write-only, NO refresh path —
    //     accumulated signal lines must never be clobbered.
    await ensureDir(join(vaultPath, "preferences"));
    const signalsOutcome = await writeIfMissing(
      join(vaultPath, "preferences", "signals.md"),
      SIGNALS_MD_TEMPLATE,
    );

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
      // Stage `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `core.md`, and
      // `.dome/config.yaml`. Empty dirs (`wiki/`, `.dome/state/`) aren't
      // committable by git; they survive on disk for the user's first
      // write.
      await commit({
        path: vaultPath,
        message: INITIAL_COMMIT_MESSAGE,
        author: { name: "dome init", email: "dome-init@local" },
        files: initialCommitFiles(options.modelProvider, sourceKinds),
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
      configYaml: configResult.outcome,
      grantsAdded: configResult.grantsAdded,
      modelProvider: modelProviderOutcome,
      sources: sourcesOutcome,
      gitignore: gitignoreOutcome,
      coreMd: coreOutcome,
      signalsMd: signalsOutcome,
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

/**
 * `writeIfMissing` with the executable bit set on creation — used for the
 * `.dome/bin/fetch-<kind>.sh` adapters so the owner can run them directly.
 * An existing file keeps both its content and its mode.
 */
async function writeExecutableIfMissing(
  path: string,
  content: string,
): Promise<StepOutcome> {
  if (existsSync(path)) return "skipped (already present)";
  await writeFile(path, content, { encoding: "utf8", mode: 0o755 });
  return "created";
}

type ConfigYamlResult = {
  readonly outcome: StepOutcome;
  /** Human-readable one-liners describing each grant/stanza the refresh added. */
  readonly grantsAdded: ReadonlyArray<string>;
};

async function ensureConfigYaml(opts: {
  readonly path: string;
  readonly refresh: boolean;
  readonly modelProvider?: DefaultModelProvider | undefined;
  readonly sources?: ReadonlyArray<DefaultSourceKind> | undefined;
}): Promise<ConfigYamlResult> {
  if (!existsSync(opts.path)) {
    await writeFile(
      opts.path,
      defaultConfigYaml({
        modelProvider: opts.modelProvider,
        sources: opts.sources,
      }),
      "utf8",
    );
    return { outcome: "created", grantsAdded: [] };
  }
  if (!opts.refresh) return { outcome: "skipped (already present)", grantsAdded: [] };

  const body = await readFile(opts.path, "utf8");
  const doc = parseConfigDocument(body);
  // A vault on the `grants: standard` preset (Task 18) already tracks every
  // enabled first-party bundle's shipped default grants at load time — refresh
  // is a no-op for grants there, and missing bundles are added enabled-only so
  // the preset keeps supplying their grants. Only a LEGACY ENUMERATED vault
  // (one that opted out of the preset with explicit grant blocks) gets the
  // grant merge below.
  const grantMergeEnabled = configRoot(doc).get("grants") !== "standard";
  const doctorEntriesById = grantMergeEnabled
    ? await loadFirstPartyDoctorGrantEntries()
    : new Map<string, ReadonlyArray<ManifestGrantEntryRequirement>>();

  const { changed, grantsAdded } = refreshFirstPartyDefaultConfig(
    doc,
    grantMergeEnabled,
    doctorEntriesById,
  );
  if (!changed) return { outcome: "skipped (already present)", grantsAdded: [] };
  await writeFile(opts.path, stringifyConfigDocument(doc), "utf8");
  return { outcome: "updated", grantsAdded };
}

/**
 * Read the shipped first-party bundle manifests and return each bundle's
 * `doctor.grantEntries` requirements, keyed by bundle id. These are the same
 * declarative rows `dome doctor`'s `capability.grant-entry-missing` probe
 * evaluates; `--refresh-config` uses them as the merge gate so it fills exactly
 * the load-bearing grants a legacy enumerated vault is missing (not the whole
 * default block, which would undo an owner's deliberate narrowing). A manifest
 * that won't parse is skipped — that broader failure surfaces via `dome doctor`
 * / `dome serve`, and refresh just declines to merge for that bundle.
 */
async function loadFirstPartyDoctorGrantEntries(): Promise<
  Map<string, ReadonlyArray<ManifestGrantEntryRequirement>>
> {
  const root = resolveShippedBundlesRoot();
  const byId = new Map<string, ReadonlyArray<ManifestGrantEntryRequirement>>();
  for (const def of FIRST_PARTY_EXTENSION_DEFAULTS) {
    try {
      const manifestPath = join(root, def.id, "manifest.yaml");
      if (!existsSync(manifestPath)) continue;
      const parsed = parseManifest(parseDocument(await readFile(manifestPath, "utf8")).toJSON());
      if (!parsed.ok) continue;
      const entries = parsed.value.doctor?.grantEntries ?? [];
      if (entries.length > 0) byId.set(def.id, entries);
    } catch {
      // Unreadable shipped manifest — skip this bundle's grant merge.
    }
  }
  return byId;
}

// ----- Comment-preserving config edits ---------------------------------------
//
// Every config-ensure path edits `.dome/config.yaml` through the yaml
// package's Document API: parseDocument → targeted node edits → stringify.
// Hand-written comments and formatting on untouched nodes survive — the
// old parse/stringify-of-plain-objects rewrite deleted every comment in
// the file (second-user blocker, fixed in v1 chunk 8). Known documented
// caveat (empirically observed against yaml@2.9; not pinned by a test): an
// inline comment trailing a block-collection KEY (`calendar: # note`) is
// repositioned to the next line; it is never deleted.

/** Parse the config body, requiring a top-level YAML mapping. */
function parseConfigDocument(body: string): Document {
  const doc = parseDocument(body);
  if (!isMap(doc.contents)) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  return doc;
}

/**
 * Stringify with line folding disabled so long untouched lines (comments
 * survive verbatim regardless) and long inserted scalars are never
 * re-wrapped at the default 80-column width, and without flow-collection
 * padding (`["sh", ...]`, not `[ "sh", ... ]`) to match the shipped
 * default-config rendering in ../default-vault-config.ts.
 */
function stringifyConfigDocument(doc: Document): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** `doc.contents` as a mapping (guaranteed by `parseConfigDocument`). */
function configRoot(doc: Document): YAMLMap {
  if (!isMap(doc.contents)) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  return doc.contents;
}

/**
 * `map.get(key)` when the value is a mapping, else null — the Document-API
 * analogue of `recordFromYaml(record[key])`.
 */
function mapAt(map: YAMLMap, key: string): YAMLMap | null {
  const value = map.get(key);
  return isMap(value) ? value : null;
}

/**
 * Ensure `map[key]` is a mapping, creating (or replacing a non-mapping
 * value with) an empty one when needed. Mirrors the previous plain-object
 * behavior of `recordFromYaml(x) ?? (x = {})`.
 */
function ensureMapAt(doc: Document, map: YAMLMap, key: string): YAMLMap {
  const existing = map.get(key);
  if (isMap(existing)) return existing;
  const created = doc.createNode({});
  map.set(doc.createNode(key), created);
  return created;
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
    await readModelProviderTemplate(opts.provider),
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
  const doc = parseConfigDocument(body);
  const root = configRoot(doc);
  if (mapAt(root, "model_provider") !== null) {
    return "skipped (already present)";
  }
  root.set(
    doc.createNode("model_provider"),
    doc.createNode(defaultModelProviderConfig(opts.provider)),
  );
  await writeFile(opts.path, stringifyConfigDocument(doc), "utf8");
  return "updated";
}

/**
 * Scaffold the requested `--with-source` kinds: copy each shipped fetch
 * adapter template to `.dome/bin/fetch-<kind>.sh` (executable, first-write-
 * only — the owner reviews and edits the script, init never overwrites it)
 * and ensure the matching disabled subscription stanza exists in the config.
 * Mirrors `ensureModelProvider`: works the same on fresh and existing
 * vaults, and never changes anything already present (in particular it
 * never flips an existing `enabled` value — consent stays with the owner).
 */
async function ensureSources(opts: {
  readonly vaultPath: string;
  readonly configPath: string;
  readonly kinds: ReadonlyArray<DefaultSourceKind>;
}): Promise<StepOutcome> {
  if (opts.kinds.length === 0) return "skipped (not requested)";

  await mkdir(join(opts.vaultPath, ".dome", "bin"), { recursive: true });
  const outcomes: StepOutcome[] = [];
  for (const kind of opts.kinds) {
    const scriptPath = join(opts.vaultPath, ".dome", "bin", `fetch-${kind}.sh`);
    outcomes.push(
      await writeExecutableIfMissing(
        scriptPath,
        await readSourceHandlerTemplate(kind),
      ),
    );
    outcomes.push(
      await ensureSourceSubscriptionConfig({ path: opts.configPath, kind }),
    );
  }
  return summarizeProviderOutcomes(outcomes);
}

/**
 * Ensure `extensions.dome.sources.config.subscriptions.<kind>` exists,
 * inserting the shipped default stanza (`enabled: false`) when absent. An
 * existing entry — whatever its shape or `enabled` value — is user-owned
 * config and is left byte-untouched, matching the `--refresh-config`
 * stance (fill missing keys, never change present ones).
 */
async function ensureSourceSubscriptionConfig(opts: {
  readonly path: string;
  readonly kind: DefaultSourceKind;
}): Promise<StepOutcome> {
  const body = await readFile(opts.path, "utf8");
  const doc = parseConfigDocument(body);
  const root = configRoot(doc);
  const extensions = ensureMapAt(doc, root, "extensions");
  if (!extensions.has("dome.sources")) {
    // No dome.sources stanza at all (a pre-sources vault): insert the full
    // first-party default — the same whole-stanza fill `--refresh-config`
    // performs — then ensure the requested kind inside it.
    extensions.set(
      doc.createNode("dome.sources"),
      doc.createNode(defaultSourcesExtensionStanza()),
    );
  }
  const sources = mapAt(extensions, "dome.sources");
  if (sources === null) {
    throw new Error(
      "extensions.dome.sources in .dome/config.yaml must be a YAML mapping",
    );
  }
  const config = ensureMapAt(doc, sources, "config");
  const subscriptions = ensureMapAt(doc, config, "subscriptions");
  if (subscriptions.has(opts.kind)) {
    return "skipped (already present)";
  }
  subscriptions.set(
    doc.createNode(opts.kind),
    doc.createNode(defaultSourceSubscription(opts.kind)),
  );
  await writeFile(opts.path, stringifyConfigDocument(doc), "utf8");
  return "updated";
}

function defaultSourcesExtensionStanza(): Record<string, unknown> {
  const defaults = recordFromYaml(defaultConfigRecord().extensions);
  const stanza = defaults === null ? null : recordFromYaml(defaults["dome.sources"]);
  if (stanza === null) {
    throw new Error("first-party defaults are missing the dome.sources stanza");
  }
  return stanza;
}

/**
 * Read the shipped fetch-adapter template from
 * `<SDK>/assets/source-handlers/claude-<kind>.sh`. Like the model-provider
 * template, it is shipped data resolved at runtime and copied into the
 * vault — never imported by any `src/` module.
 */
async function readSourceHandlerTemplate(
  kind: DefaultSourceKind,
): Promise<string> {
  const path = join(resolveShippedSourceHandlersRoot(), `claude-${kind}.sh`);
  return readFile(path, "utf8");
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

// ----- First-party default reconciliation (`--refresh-config`) --------------
//
// Two distinct edits, both insert-only (never remove or narrow an existing
// entry; b681311's comment-preserving Document-API path is used throughout):
//
//   1. A MISSING first-party bundle stanza is added. On a legacy enumerated
//      vault it carries its FULL shipped default grant block (bundle grant +
//      per-processor replacement grants) so the bundle is not stranded
//      grantless — the failure mode NEEDS_ARE_LOUD incident #4 named. On a
//      `grants: standard` vault it is added enabled-only (the preset supplies
//      the grants).
//
//   2. A PRESENT, enabled first-party bundle on a legacy enumerated vault is
//      brought up to the shipped default. A grant KIND the default declares but
//      the vault omits entirely (`patch.auto`, `graph.write`, `question.ask`, …)
//      lands at its full default — a capability the bundle's processors gained
//      since the config was written (the kind-level `capability.grant-missing`
//      starvation, NEEDS_ARE_LOUD incident #4). A kind the vault DOES list is
//      owner-authored and is merged into only surgically, gated by the bundle
//      manifest's `doctor.grantEntries` — the same rows `dome doctor`'s
//      `capability.grant-entry-missing` probe checks. Such a bundle-level entry
//      adds the most-specific shipped default glob that covers the entry's
//      target (a probe target like `sources/calendar/2026-01-01.md` yields the
//      default glob `sources/calendar/*.md`, and `core.md` yields `core.md`,
//      never `**/*.md` — a deliberately narrowed list survives). Per-processor
//      entries (whose processor has a shipped replacement grant) add the full
//      replacement stanza when the vault carries none, matching the doctor
//      recovery text. A `grants: standard` vault skips (2) entirely — the preset
//      already tracks defaults.

function refreshFirstPartyDefaultConfig(
  doc: Document,
  grantMergeEnabled: boolean,
  doctorEntriesById: ReadonlyMap<string, ReadonlyArray<ManifestGrantEntryRequirement>>,
): { readonly changed: boolean; readonly grantsAdded: ReadonlyArray<string> } {
  const extensions = mapAt(configRoot(doc), "extensions");
  if (extensions === null) return { changed: false, grantsAdded: [] };

  let changed = false;
  const grantsAdded: string[] = [];
  const sorted = [...FIRST_PARTY_EXTENSION_DEFAULTS].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const def of sorted) {
    if (!extensions.has(def.id)) {
      extensions.set(
        doc.createNode(def.id),
        doc.createNode(missingBundleStanza(def, grantMergeEnabled)),
      );
      changed = true;
      grantsAdded.push(
        grantMergeEnabled
          ? `${def.id} (bundle added with default grants)`
          : `${def.id} (bundle added)`,
      );
      continue;
    }

    const extension = mapAt(extensions, def.id);
    if (extension === null) continue;
    if (extension.get("enabled") !== true) continue;
    // `grants: standard` vaults keep the preset as the single source of grants:
    // present bundles are left byte-untouched.
    if (!grantMergeEnabled) continue;

    const requirements = doctorEntriesById.get(def.id) ?? [];
    const grantKey = grantKeyFor(extension);
    // A non-mapping grant value (`grant: off`) is user-owned config the refresh
    // has no safe way to reconcile — leave the whole bundle alone.
    const existingGrant = extension.get(grantKey);
    if (existingGrant !== undefined && !isMap(existingGrant)) continue;
    const bundleGrant = ensureMapAt(doc, extension, grantKey);

    // (1) Fill wholly-missing default grant KINDS with the full shipped default.
    // A kind the enumerated grant does not list at all is a capability the
    // bundle's processors gained since the config was written — the
    // "arrives capability-starved" gap (NEEDS_ARE_LOUD incident #4), and the
    // kind-level `capability.grant-missing` doctor finding. There is no
    // owner-authored value to respect, so the whole default lands. A kind the
    // vault DOES list is owner-authored and is only merged into surgically (2).
    for (const kind of Object.keys(def.grant)) {
      if (bundleGrant.has(kind)) continue;
      bundleGrant.set(doc.createNode(kind), doc.createNode(structuredClone(def.grant[kind])));
      changed = true;
      grantsAdded.push(`${def.id}.${grantKey}.${kind} (default grant added)`);
    }

    // (2) Merge the load-bearing `doctor.grantEntries` into kinds the vault
    // already carries (surgical — respects a deliberately narrowed list) and
    // add per-processor replacement grants the vault lacks.
    for (const requirement of requirements) {
      const replacement = def.processors?.[requirement.processorId];
      if (replacement !== undefined) {
        if (
          addPerProcessorReplacementGrant(doc, extension, requirement.processorId, replacement)
        ) {
          changed = true;
          grantsAdded.push(
            `${def.id}.processors."${requirement.processorId}".grant (replacement grant added)`,
          );
        }
        continue;
      }
      for (const entry of requirement.entries) {
        const added = mergeGrantEntry(
          doc,
          bundleGrant,
          entry.kind,
          entry.target,
          def.grant[entry.kind],
        );
        if (added !== null) {
          changed = true;
          grantsAdded.push(`${def.id}.${grantKey}.${entry.kind} += ${JSON.stringify(added)}`);
        }
      }
    }
  }
  return { changed, grantsAdded };
}

/**
 * The stanza inserted for a first-party bundle that a refreshed config lacks.
 * On a legacy enumerated vault it carries the full shipped default grant block
 * (bundle grant + per-processor replacement grants, each wrapped as
 * `processors.<id>.grant`). On a `grants: standard` vault it is enabled-only
 * (with any shipped `config:`), leaving the preset to supply grants.
 */
function missingBundleStanza(
  def: FirstPartyExtensionDefault,
  grantMergeEnabled: boolean,
): Record<string, unknown> {
  const stanza: Record<string, unknown> = { enabled: def.enabled };
  if (def.config !== undefined) stanza.config = structuredClone(def.config);
  if (!grantMergeEnabled) return stanza;
  stanza.grant = structuredClone(def.grant);
  if (def.processors !== undefined) {
    stanza.processors = Object.fromEntries(
      Object.entries(def.processors).map(([procId, grant]) => [
        procId,
        { grant: structuredClone(grant) },
      ]),
    );
  }
  return stanza;
}

/**
 * Add a per-processor replacement grant stanza
 * (`extensions.<bundle>.processors.<id>.grant`) from the shipped default when
 * the vault carries none for that processor. An existing per-processor block is
 * user-owned config — left untouched.
 */
function addPerProcessorReplacementGrant(
  doc: Document,
  extension: YAMLMap,
  processorId: string,
  grant: Readonly<Record<string, DefaultGrantValue>>,
): boolean {
  const processors = ensureMapAt(doc, extension, "processors");
  if (processors.has(processorId)) return false;
  processors.set(
    doc.createNode(processorId),
    doc.createNode({ grant: structuredClone(grant) }),
  );
  return true;
}

/**
 * Merge one missing grant entry into a bundle grant list. Returns the glob
 * added, or null when nothing was added (already covered, no covering default
 * glob, or a value refresh must respect). The glob added is the most-specific
 * shipped default glob that covers `target`, so a doctor probe target resolves
 * to the canonical default pattern rather than a one-off path, and a narrow
 * default (e.g. `core.md`) wins over a broad one (`**\/*.md`).
 */
function mergeGrantEntry(
  doc: Document,
  grantMap: YAMLMap,
  kind: string,
  target: string,
  defaultValue: DefaultGrantValue | undefined,
): string | null {
  const covering = grantGlobList(defaultValue).filter((glob) => globMatch(glob, target));
  if (covering.length === 0) return null;
  const glob = mostSpecificGlob(covering);

  const existing = grantMap.get(kind);
  if (existing === undefined) {
    grantMap.set(doc.createNode(kind), doc.createNode([glob]));
    return glob;
  }
  // A scalar grant value (`read: off`, `question.ask: false`) is user-owned
  // config the refresh has no safe way to merge a list entry into — leave it
  // alone.
  if (!isSeq(existing)) return null;
  const items = existing.toJSON() as unknown[];
  // An explicitly EMPTY list is deliberate withholding, not stale config
  // (omission ≠ withholding — wiki/specs/cli.md §"dome init"): never merged
  // into, even when a doctor row names a missing entry for the kind.
  if (items.length === 0) return null;
  const covered = items.some(
    (item) => typeof item === "string" && globMatch(item, target),
  );
  if (covered || items.includes(glob)) return null;
  existing.add(doc.createNode(glob));
  return glob;
}

/** The string globs of a shipped default grant value (a path/namespace list). */
function grantGlobList(value: DefaultGrantValue | undefined): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The most-specific glob: fewest `*` wildcards, then longest, then lexical.
 * `core.md` beats `**\/*.md`; `sources/calendar/*.md` is the sole cover for a
 * dated probe path.
 */
function mostSpecificGlob(globs: ReadonlyArray<string>): string {
  return [...globs].sort((a, b) => {
    const byStars = starCount(a) - starCount(b);
    if (byStars !== 0) return byStars;
    if (a.length !== b.length) return b.length - a.length;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
}

function starCount(glob: string): number {
  let n = 0;
  for (const ch of glob) if (ch === "*") n += 1;
  return n;
}

function grantKeyFor(extension: YAMLMap): "grant" | "grants" {
  return extension.has("grants") && !extension.has("grant")
    ? "grants"
    : "grant";
}

/**
 * Read the shipped provider template from
 * `<SDK>/assets/model-providers/<provider>.ts`. The template is shipped
 * data resolved at runtime (like the `assets/extensions/` bundles) — it is
 * copied into the vault as `.dome/model-provider.ts` and is never imported
 * by any `src/` module, keeping ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY intact.
 */
async function readModelProviderTemplate(
  provider: DefaultModelProvider,
): Promise<string> {
  const path = join(resolveShippedModelProvidersRoot(), `${provider}.ts`);
  return readFile(path, "utf8");
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
  sourceKinds: ReadonlyArray<DefaultSourceKind>,
): ReadonlyArray<string> {
  const files = [
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "core.md",
    "preferences/signals.md",
    ".dome/config.yaml",
    // Commit the inbox keepers so a freshly-initialized vault has a clean
    // working tree (untracked files would read as dirty in `dome status`).
    "inbox/raw/.gitkeep",
    "inbox/processed/.gitkeep",
  ];
  if (provider !== undefined) files.push(".dome/model-provider.ts");
  for (const kind of sourceKinds) files.push(`.dome/bin/fetch-${kind}.sh`);
  return files;
}

function recordFromYaml(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
  if (s.grantsAdded.length > 0) {
    lines.push(...section("Grants Added", bullets(s.grantsAdded, caps, "none"), caps));
  }
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
    [".dome/bin/fetch-<kind>.sh", s.sources],
    [".gitignore", s.gitignore],
    ["core.md", s.coreMd],
    ["preferences/signals.md", s.signalsMd],
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
      sources: s.sources,
      gitignore: s.gitignore,
      core_md: s.coreMd,
      signals_md: s.signalsMd,
      agents_md: s.agentsMd,
      claude_md: s.claudeMd,
      initial_commit: s.initialCommit,
    },
    grants_added: s.grantsAdded,
  };
}

// ----- Templates ------------------------------------------------------------
//
// The template string literals (default `.gitignore`, `core.md`,
// `preferences/signals.md`, `CLAUDE.md`, the AGENTS.md renderer, and the
// initial commit message) live in ./init-templates.ts — still in code, not
// under assets/, so a single-file `bun build` CLI stays self-contained; see
// that module's header. Only the user-prose delimiter constants and the
// composed AGENTS_MD_TEMPLATE stay here (the lockstep test
// tests/invariants/agents-md-is-orientation-surface.test.ts greps this file
// for the delimiters).

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
