// cli/default-vault-config: typed shipped config for newly initialized vaults.
//
// `dome init` renders this structure into `.dome/config.yaml`. Fresh vaults
// ship the `grants: standard` preset (one line at top level) instead of the
// enumerated per-bundle grant blocks: the config loader expands the preset at
// load time to the union of every enabled first-party bundle's shipped default
// grants (docs/wiki/specs/capabilities.md §"Vault grants"). The enumerated
// per-bundle `grant:`/`grants:`/`processors:` form stays valid config and
// remains the escape hatch — an explicit block wins entirely for that bundle.
//
// The shipped grant/config DATA lives in src/first-party-defaults.ts so the
// engine config loader (src/engine/core/capability-policy.ts) can read it
// without an engine→cli import; the symbols are re-exported here for the CLI's
// historical import sites (init, inspect, and the config lockstep tests).

import {
  DEFAULT_SOURCE_KINDS,
  FIRST_PARTY_EXTENSION_DEFAULTS,
  defaultSourceSubscription,
  type DefaultConfigValue,
  type DefaultGrantValue,
  type DefaultSourceKind,
  type FirstPartyExtensionDefault,
} from "../first-party-defaults";

export { DEFAULT_SOURCE_KINDS, FIRST_PARTY_EXTENSION_DEFAULTS, defaultSourceSubscription };
export type {
  DefaultConfigValue,
  DefaultGrantValue,
  DefaultSourceKind,
  FirstPartyExtensionDefault,
};

export type DefaultModelProvider = "anthropic";

export function defaultConfigRecord(opts: {
  readonly modelProvider?: DefaultModelProvider | undefined;
  readonly sources?: ReadonlyArray<DefaultSourceKind> | undefined;
} = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    // The one-line preset. The loader expands it to each enabled bundle's
    // shipped default grants; a bundle carrying an explicit grant/processors
    // block opts out and uses only that block.
    grants: "standard",
    extensions: Object.fromEntries(
      firstPartyDefaultsWithSources(opts.sources).map((entry) => [
        entry.id,
        {
          enabled: entry.enabled,
          ...(entry.config !== undefined
            ? { config: structuredClone(entry.config) }
            : {}),
        },
      ]),
    ),
    engine: {
      max_iterations: 100,
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
    DEFAULT_GRANTS_PRESET +
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

function renderExtension(entry: FirstPartyExtensionDefault): string {
  // Fresh vaults render enabled + optional config only — grants come from the
  // top-level `grants: standard` preset the loader expands. The enumerated
  // grant/processors blocks are intentionally NOT written here (they remain
  // valid escape-hatch config a vault can add by hand).
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
    "",
  ].join("\n");
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

const DEFAULT_GRANTS_PRESET = `# Capability grants. \`standard\` expands at load time to the union of every
# enabled first-party bundle's shipped default grants — one line where the
# enumerated per-bundle blocks used to be. To override one bundle, give it an
# explicit \`grant:\`/\`grants:\` (or per-processor \`processors:\`) block under
# its stanza below: a fine-grained block wins entirely for that bundle (the
# preset is ignored for it — no merging within a bundle). See
# docs/wiki/specs/capabilities.md §"Vault grants".
grants: standard

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
