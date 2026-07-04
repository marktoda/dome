// cli/default-vault-config: typed shipped config for newly initialized vaults.
//
// `dome init` renders this structure into `.dome/config.yaml`, and the
// `--refresh-config` path uses the same structure to fill missing first-party
// bundle stanzas/grant keys. Keep first-party defaults here so extension
// capability changes have one source of truth instead of a large YAML literal.

export type DefaultGrantValue =
  | boolean
  | number
  | string
  | ReadonlyArray<string>
  | Readonly<Record<string, boolean | number | string>>;

/**
 * Opaque per-extension `config:` payload (`extensions.<bundle>.config`).
 * Recursive JSON-ish shape so defaults can carry nested mappings (e.g. the
 * dome.sources subscriptions block). Rendered to YAML by
 * `renderConfigValue` and round-trip-tested against `defaultConfigRecord`.
 */
export type DefaultConfigValue =
  | boolean
  | number
  | string
  | ReadonlyArray<DefaultConfigValue>
  | { readonly [key: string]: DefaultConfigValue };

export type FirstPartyExtensionDefault = {
  readonly id: string;
  readonly enabled: boolean;
  /**
   * Optional shipped per-extension config (`extensions.<bundle>.config`).
   * Used where the consent surface ships visible-but-off defaults — e.g.
   * dome.sources ships the calendar subscription with `enabled: false`
   * so opting in is a one-line flip (wiki/specs/sources.md).
   */
  readonly config?: Readonly<Record<string, DefaultConfigValue>>;
  readonly grant: Readonly<Record<string, DefaultGrantValue>>;
  /**
   * Optional per-processor REPLACEMENT grants
   * (`extensions.<bundle>.processors.<id>.grant`). Used where one processor's
   * effective grant must differ from the bundle's — e.g. the
   * preference-promotion answer handler is the single processor allowed to
   * auto-write `core.md` (memory decision 4; wiki/specs/preferences.md).
   */
  readonly processors?: Readonly<
    Record<string, Readonly<Record<string, DefaultGrantValue>>>
  >;
};

export type DefaultModelProvider = "anthropic";

/**
 * The source kinds `dome init --with-source <kind>` can scaffold: each has a
 * shipped fetch-adapter template at `assets/source-handlers/claude-<kind>.sh`
 * and a standard subscription stanza below. Scaffolding NEVER enables a
 * subscription — `enabled: false` is the shipped consent stance
 * (wiki/specs/sources.md); the owner reviews the script, then flips it.
 */
export type DefaultSourceKind = "calendar" | "slack";

export const DEFAULT_SOURCE_KINDS: ReadonlyArray<DefaultSourceKind> =
  Object.freeze(["calendar", "slack"]);

/**
 * The standard subscription stanza for a shipped source kind. Schedules sit
 * before the 05:30 morning brief so the day's feeds are committed in time:
 * calendar at 05:10, slack at 05:15.
 */
export function defaultSourceSubscription(
  kind: DefaultSourceKind,
): Readonly<Record<string, DefaultConfigValue>> {
  switch (kind) {
    case "calendar":
      return Object.freeze({
        enabled: false,
        schedule: "10 5 * * *",
        output_path: "sources/calendar/{date}.md",
        command: Object.freeze(["sh", ".dome/bin/fetch-calendar.sh"]),
      });
    case "slack":
      return Object.freeze({
        enabled: false,
        schedule: "15 5 * * *",
        output_path: "sources/slack/{date}.md",
        command: Object.freeze(["sh", ".dome/bin/fetch-slack.sh"]),
      });
  }
  const _exhaustive: never = kind;
  return _exhaustive;
}

export const FIRST_PARTY_EXTENSION_DEFAULTS: ReadonlyArray<FirstPartyExtensionDefault> =
  Object.freeze([
    extension("dome.lint", true, {
      read: ["**/*.md"],
    }),
    extension("dome.markdown", true, {
      read: [
        "**/*.md",
        // core.md is named explicitly (not left to "**/*.md" matching) so
        // the dome.markdown.core-size lint's read grant survives vaults
        // that narrow the markdown read scope (e.g. to wiki/**) — see
        // docs/memory.md §"Vault rollout".
        "core.md",
        ".dome/page-types.yaml",
        "**/*.{png,jpg,jpeg,gif,webp,svg,avif}",
        "raw/**",
      ],
      "patch.auto": ["**/*.md"],
      "graph.write": ["dome.page.*"],
      "question.ask": true,
    }),
    extension("dome.graph", true, {
      read: ["**/*.md"],
      "graph.write": ["dome.graph.*"],
    }),
    extension("dome.daily", true, {
      // sources/* + the sweep ledger feed dome.daily.compose-blocks (the
      // deterministic agenda / integrated-overnight / sources blocks);
      // without them the reads return null and the blocks silently never
      // render (grant-scoped snapshot misses are silent).
      read: [
        "wiki/**/*.md",
        "notes/*.md",
        "sources/calendar/*.md",
        "sources/slack/*.md",
        "meta/sweep-ledger.md",
      ],
      "patch.auto": ["wiki/**/*.md", "notes/*.md"],
      "graph.write": ["dome.daily.*"],
      "question.ask": true,
      // dome.daily.compose-blocks reads open question rows via
      // ctx.operational.questions to render the deterministic "To decide"
      // block (daily-surface §"Block ownership").
      "questions.read": true,
    }),
    extension("dome.claims", true, {
      read: ["wiki/**/*.md", "notes/*.md"],
      "patch.auto": ["wiki/**/*.md", "notes/*.md"],
      "graph.write": ["dome.claims.*"],
    }),
    extension(
      "dome.agent",
      false,
      {
        // core.md is deliberately read-only here (the canonical propose-only
        // grant shape): agents read core memory every run but never
        // auto-write it. Keep core.md out of the bundle patch.auto — its
        // only gated writers are the two block-scoped processors with the
        // narrow per-processor replacement grants below (each owns a
        // distinct generated block; everything else is propose-only).
        read: [
          "wiki/**/*.md",
          "notes/**/*.md",
          "inbox/**/*.md",
          "index.md",
          "log.md",
          "meta/consolidation-ledger.md",
          "meta/sweep-ledger.md",
          // The staleness patrol's nightly review queue: dome.agent.patrol
          // writes it (its own replacement grant), dome.agent.consolidate READS
          // it under this bundle grant to pull the frozen tail into scope
          // (wiki/specs/autonomous-agents.md §"Patrol").
          "meta/patrol-queue.md",
          "sources/calendar/*.md",
          "sources/slack/*.md",
          "core.md",
          "preferences/signals.md",
        ],
        // index.md and log.md are deliberately absent here (read stays
        // above): the index is a generated projection of description
        // frontmatter and the activity log is git history — agents read
        // them for context but never write them.
        "patch.auto": [
          "wiki/**/*.md",
          "notes/**/*.md",
          "meta/consolidation-ledger.md",
          "meta/sweep-ledger.md",
          "inbox/processed/*.md",
          "inbox/raw/*.md",
          "preferences/signals.md",
        ],
        // dome.preference.* carries the deterministic preference counter
        // facts (wiki/specs/preferences.md) emitted by
        // dome.agent.preference-signals; the model processors declare no
        // graph.write (MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS).
        "graph.write": ["dome.preference.*"],
        "model.invoke": Object.freeze({ maxDailyCostUsd: 5 }),
        "question.ask": true,
      },
      {
        // The two-gated-writers contract (memory decision 4 evolved;
        // wiki/specs/preferences.md): core.md's only auto-writers are these
        // two deterministic processors, each owning ONE distinct generated
        // block. The promotion answer handler owns promoted-preferences
        // (the promotion question WAS the owner review); active-projects
        // owns the active-projects block. Replacement grants stay exact:
        // the core page (+ the signals page for rejection tombstones) and,
        // for active-projects, the dailies its tallies are derived from.
        "dome.agent.preference-promotion-answer": Object.freeze({
          read: ["core.md", "preferences/signals.md"],
          "patch.auto": ["core.md", "preferences/signals.md"],
        }),
        "dome.agent.active-projects": Object.freeze({
          read: ["core.md", "wiki/dailies/*.md"],
          "patch.auto": ["core.md"],
        }),
        // The deterministic staleness patrol (product-review-3 Task 15;
        // wiki/specs/autonomous-agents.md §"Patrol"): a per-processor
        // replacement grant, because it needs its own meta/patrol-* files
        // that the bundle-wide grant does not cover. Reads the three page
        // families it grooms (staleness + oversize scan) + its two meta files;
        // writes ONLY the two meta files (queue + bounded ledger). No model,
        // no facts.
        "dome.agent.patrol": Object.freeze({
          read: [
            "wiki/entities/**/*.md",
            "wiki/concepts/**/*.md",
            "wiki/syntheses/**/*.md",
            "meta/patrol-queue.md",
            "meta/patrol-ledger.md",
          ],
          "patch.auto": ["meta/patrol-queue.md", "meta/patrol-ledger.md"],
        }),
        // The DETERMINISTIC index extractors (not model processors) publish the
        // cross-bundle facts the cockpit's today view reads: brief-index emits
        // dome.agent.brief from the daily note's brief block, calendar-index
        // emits dome.agent.calendar.event from sources/calendar. The bundle-wide
        // graph.write stays dome.preference.* (MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS);
        // these per-processor grants are the exact namespaces each deterministic
        // extractor needs. Replacement grants restate read.
        "dome.agent.brief-index": Object.freeze({
          read: ["wiki/dailies/*.md", "notes/*.md"],
          "graph.write": ["dome.agent"],
        }),
        "dome.agent.calendar-index": Object.freeze({
          read: ["sources/calendar/*.md"],
          "graph.write": ["dome.agent.calendar.*"],
        }),
      },
    ),
    extension("dome.search", true, {
      read: ["**/*.md"],
      "search.write": ["**/*.md"],
    }),
    // dome.sources — external-feed subscriptions (wiki/specs/sources.md).
    // The bundle is enabled (its 15-minute fetch tick is a cheap no-op when
    // nothing is due) but every shipped subscription is `enabled: false`:
    // consent is the per-subscription flip plus the vault-authored fetch
    // command (copy assets/source-handlers/claude-calendar.sh into
    // .dome/bin/ and adjust).
    extensionWithConfig(
      "dome.sources",
      true,
      {
        subscriptions: {
          calendar: defaultSourceSubscription("calendar"),
        },
      },
      {
        read: ["sources/**/*.md", ".dome/config.yaml"],
        external: ["sources.fetch"],
      },
    ),
    extension(
      "dome.health",
      true,
      {
        read: ["**"],
        "outbox.read": ["failed"],
        "question.ask": true,
        "outbox.recover": true,
        "quarantine.read": true,
        "quarantine.recover": true,
        "run.read": ["running"],
        "run.recover": true,
      },
      {
        // The weekly report card needs a WIDER run.read (all statuses, to count
        // failures/quarantines/productive) plus patch.auto — neither of which
        // the recovery-processor bundle grant carries. A replacement grant
        // scopes it exactly: the two files it writes, all run statuses, and
        // questions.read; it does NOT inherit the bundle's read:["**"], so the
        // reads it needs are restated. Normative: daily-surface §"Report card".
        "dome.health.report-card": Object.freeze({
          read: [
            "wiki/dailies/*.md",
            "meta/report-card.md",
            "meta/retrieval-misses.md",
          ],
          "patch.auto": ["meta/report-card.md", "wiki/dailies/*.md"],
          "run.read": true,
          "questions.read": true,
        }),
      },
    ),
  ]);

export function defaultConfigRecord(opts: {
  readonly modelProvider?: DefaultModelProvider | undefined;
  readonly sources?: ReadonlyArray<DefaultSourceKind> | undefined;
} = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    extensions: Object.fromEntries(
      firstPartyDefaultsWithSources(opts.sources).map((entry) => [
        entry.id,
        {
          enabled: entry.enabled,
          ...(entry.config !== undefined
            ? { config: structuredClone(entry.config) }
            : {}),
          grant: cloneGrant(entry.grant),
          ...(entry.processors !== undefined
            ? {
                processors: Object.fromEntries(
                  Object.entries(entry.processors).map(
                    ([processorId, grant]) => [
                      processorId,
                      { grant: cloneGrant(grant) },
                    ],
                  ),
                ),
              }
            : {}),
        },
      ]),
    ),
    engine: {
      max_iterations: 100,
      auto_resolve_questions: {
        enabled: true,
        policies: ["agent-safe"],
        min_confidence: 0.6,
        max_per_tick: 20,
      },
      auto_commit_workflows: true,
    },
    git: {
      auto_commit_workflows: true,
    },
    ledger: {
      retention_days: 30,
    },
  };
  if (opts.modelProvider !== undefined) {
    record.model_provider = defaultModelProviderConfig(opts.modelProvider);
  }
  return record;
}

export function defaultConfigYaml(opts: {
  readonly modelProvider?: DefaultModelProvider | undefined;
  readonly sources?: ReadonlyArray<DefaultSourceKind> | undefined;
} = {}): string {
  return (
    DEFAULT_CONFIG_HEADER +
    renderModelProviderConfig(opts.modelProvider) +
    "extensions:\n" +
    firstPartyDefaultsWithSources(opts.sources)
      .map(renderExtension)
      .join("\n") +
    "\n" +
    DEFAULT_CONFIG_FOOTER
  );
}

/**
 * The first-party defaults with the requested source kinds' subscription
 * stanzas merged into `dome.sources` (`--with-source`). Kinds whose stanza
 * already ships (calendar) are no-ops, so the unmodified frozen array is
 * returned when nothing new is requested.
 */
function firstPartyDefaultsWithSources(
  sources: ReadonlyArray<DefaultSourceKind> | undefined,
): ReadonlyArray<FirstPartyExtensionDefault> {
  if (sources === undefined || sources.length === 0) {
    return FIRST_PARTY_EXTENSION_DEFAULTS;
  }
  return FIRST_PARTY_EXTENSION_DEFAULTS.map((entry) => {
    if (entry.id !== "dome.sources" || entry.config === undefined) return entry;
    const subscriptions = {
      ...(entry.config.subscriptions as Readonly<
        Record<string, DefaultConfigValue>
      >),
    };
    let changed = false;
    for (const kind of sources) {
      if (kind in subscriptions) continue;
      subscriptions[kind] = defaultSourceSubscription(kind);
      changed = true;
    }
    if (!changed) return entry;
    return Object.freeze({
      ...entry,
      config: Object.freeze({ ...entry.config, subscriptions }),
    });
  });
}

function extension(
  id: string,
  enabled: boolean,
  grant: Readonly<Record<string, DefaultGrantValue>>,
  processors?: Readonly<
    Record<string, Readonly<Record<string, DefaultGrantValue>>>
  >,
): FirstPartyExtensionDefault {
  return Object.freeze({
    id,
    enabled,
    grant: Object.freeze(grant),
    ...(processors !== undefined
      ? { processors: Object.freeze(processors) }
      : {}),
  });
}

function extensionWithConfig(
  id: string,
  enabled: boolean,
  config: Readonly<Record<string, DefaultConfigValue>>,
  grant: Readonly<Record<string, DefaultGrantValue>>,
): FirstPartyExtensionDefault {
  return Object.freeze({
    id,
    enabled,
    config: Object.freeze(config),
    grant: Object.freeze(grant),
  });
}

function cloneGrant(
  grant: Readonly<Record<string, DefaultGrantValue>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(grant).map(([key, value]) => [key, structuredClone(value)]),
  );
}

function renderExtension(entry: FirstPartyExtensionDefault): string {
  return [
    `  ${entry.id}:`,
    `    enabled: ${entry.enabled ? "true" : "false"}`,
    ...(entry.config !== undefined
      ? [
          "    config:",
          ...Object.entries(entry.config).flatMap(([key, value]) =>
            renderConfigValue(key, value, 6),
          ),
        ]
      : []),
    "    grant:",
    ...Object.entries(entry.grant).flatMap(([key, value]) =>
      renderGrantValue(key, value, 6),
    ),
    ...(entry.processors !== undefined
      ? [
          "    processors:",
          ...Object.entries(entry.processors).flatMap(
            ([processorId, grant]) => [
              `      ${processorId}:`,
              "        grant:",
              ...Object.entries(grant).flatMap(([key, value]) =>
                renderGrantValue(key, value, 10),
              ),
            ],
          ),
        ]
      : []),
    "",
  ].join("\n");
}

function renderGrantValue(
  key: string,
  value: DefaultGrantValue,
  indent: number,
): ReadonlyArray<string> {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return [`${pad}${key}:`, ...value.map((item) => `${pad}  - ${quote(item)}`)];
  }
  if (value !== null && typeof value === "object") {
    return [
      `${pad}${key}:`,
      ...Object.entries(value).map(([childKey, childValue]) =>
        `${pad}  ${childKey}: ${renderScalar(childValue)}`),
    ];
  }
  return [`${pad}${key}: ${renderScalar(value)}`];
}

function renderScalar(value: boolean | number | string): string {
  if (typeof value === "string") return quote(value);
  return String(value);
}

/**
 * Render one `config:` key with a recursive JSON-ish value. Lists render
 * flow-style (`["a", "b"]`) so command argv lists stay one line; nested
 * mappings recurse block-style. Round-trip parity with
 * `defaultConfigRecord` is pinned by tests/integration/default-vault-config.
 */
function renderConfigValue(
  key: string,
  value: DefaultConfigValue,
  indent: number,
): ReadonlyArray<string> {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return [`${pad}${key}: ${renderFlowValue(value)}`];
  }
  if (value !== null && typeof value === "object") {
    return [
      `${pad}${key}:`,
      ...Object.entries(value).flatMap(([childKey, childValue]) =>
        renderConfigValue(childKey, childValue, indent + 2),
      ),
    ];
  }
  return [`${pad}${key}: ${renderScalar(value)}`];
}

function renderFlowValue(value: DefaultConfigValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(renderFlowValue).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${quote(k)}: ${renderFlowValue(v)}`)
      .join(", ")}}`;
  }
  return renderScalar(value);
}

export function defaultModelProviderConfig(
  provider: DefaultModelProvider,
): Record<string, unknown> {
  switch (provider) {
    case "anthropic":
      return {
        kind: "command",
        command: ["bun", ".dome/model-provider.ts"],
      };
  }
  const _exhaustive: never = provider;
  return _exhaustive;
}

function renderModelProviderConfig(
  provider: DefaultModelProvider | undefined,
): string {
  if (provider === undefined) return "";
  const config = defaultModelProviderConfig(provider);
  const command = config.command;
  if (!Array.isArray(command)) return "";
  return [
    "model_provider:",
    `  kind: ${renderScalar(String(config.kind))}`,
    "  command:",
    ...command.map((part) => `    - ${renderScalar(String(part))}`),
    "",
  ].join("\n") + "\n";
}

function quote(value: string): string {
  return JSON.stringify(value);
}

const DEFAULT_CONFIG_HEADER = `# Dome vault configuration (v1.0).
#
# This file controls which extensions are active and their capability
# grants. The shipped first-party bundles (\`dome.claims\`, \`dome.daily\`,
# \`dome.graph\`, \`dome.health\`, \`dome.agent\`, \`dome.lint\`,
# \`dome.markdown\`, \`dome.search\`, \`dome.sources\`) live with the SDK.
# By default, CLI
# commands compose those shipped bundles with any vault-local bundles under
# \`.dome/extensions/\`.
#
# To install a third-party bundle, create \`.dome/extensions/<bundle-id>/\`
# here and add an enabled stanza below. \`--bundles-root <path>\` is an exact
# override for tests and ad-hoc development.
#
# Model-capable bundles can use an injected host provider or a command
# provider configured here. The command runs with the vault root as cwd,
# receives a JSON request on stdin, and returns JSON on stdout:
#
# model_provider:
#   kind: command
#   command: ["bun", ".dome/model-provider.ts"]

`;

const DEFAULT_CONFIG_FOOTER = `engine:
  # Maximum iterations of the fixed-point adoption loop per Proposal.
  # Hitting this cap is a programmer error (processors not idempotent
  # or in a patch-fight); surface diagnostic + block.
  max_iterations: 100

  # Optional global execution caps. Uncomment to bound processor manifest
  # requests more tightly for this vault.
  # processor_timeout_ms: 600000
  # model_call_timeout_ms: 180000
  #
  # Per-attempt bound for external outbox handlers (default 30000). Raise it
  # when a dome.sources subscription's fetch command runs a headless model:
  # external_handler_timeout_ms: 300000
  #
  # Low-risk question auto-resolution. Dome answers unresolved questions that
  # declare low risk, an allowed automation policy, sufficient confidence, and
  # a recommended answer valid for the question options. Answer handlers still
  # run through the normal garden / adoption path. Answers are stamped
  # answered_by: auto in answers.db. Set enabled: false to opt out.
  auto_resolve_questions:
    enabled: true
    policies:
      - "agent-safe"
    min_confidence: 0.6
    max_per_tick: 20

  # Auto-commit closure commits when adoption-phase processors emit
  # patches that converge. When false, processors that emit PatchEffect
  # are dropped (with a diagnostic). Default true for normal vaults.
  auto_commit_workflows: true

git:
  # Mirror of engine.auto_commit_workflows so EngineVault.config can expose
  # the historical git-shaped flag to closure-commit code. When both keys
  # are present, they must agree.
  auto_commit_workflows: true

ledger:
  # Prune succeeded/no-op run-ledger rows older than this many days. Audit
  # rows for failures, timeouts, and each processor's newest runs are always
  # kept. Comment out to retain forever; reclaim disk with
  # \`dome repair run-ledger --apply --vacuum\`.
  retention_days: 30
`;
