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

export type FirstPartyExtensionDefault = {
  readonly id: string;
  readonly enabled: boolean;
  readonly grant: Readonly<Record<string, DefaultGrantValue>>;
};

export const FIRST_PARTY_EXTENSION_DEFAULTS: ReadonlyArray<FirstPartyExtensionDefault> =
  Object.freeze([
    extension("dome.lint", true, {
      read: ["**/*.md"],
    }),
    extension("dome.markdown", true, {
      read: [
        "**/*.md",
        ".dome/page-types.yaml",
        "**/*.{png,jpg,jpeg,gif,webp,svg,avif}",
        "raw/**",
      ],
      "patch.auto": ["**/*.md"],
      "question.ask": true,
    }),
    extension("dome.graph", true, {
      read: ["**/*.md"],
      "graph.write": ["dome.graph.*"],
    }),
    extension("dome.daily", true, {
      read: ["wiki/**/*.md"],
      "patch.auto": ["wiki/**/*.md"],
      "graph.write": ["dome.daily.*"],
      "question.ask": true,
    }),
    extension("dome.intake", false, {
      read: ["inbox/**/*.md", "wiki/generated/intake/*.md"],
      "patch.auto": [
        "wiki/generated/intake/*.md",
        "wiki/syntheses/intake-*.md",
        "inbox/processed/*.md",
        "inbox/raw/*.md",
      ],
      "graph.write": ["dome.intake.*"],
      "model.invoke": Object.freeze({ maxDailyCostUsd: 5 }),
      "question.ask": true,
    }),
    extension("dome.search", true, {
      read: ["**/*.md"],
      "search.write": ["**/*.md"],
    }),
    extension("dome.health", true, {
      read: ["**"],
      "outbox.read": ["failed"],
      "question.ask": true,
      "outbox.recover": true,
      "quarantine.read": true,
      "quarantine.recover": true,
      "run.read": ["running"],
      "run.recover": true,
    }),
  ]);

export function defaultConfigRecord(): Record<string, unknown> {
  return {
    extensions: Object.fromEntries(
      FIRST_PARTY_EXTENSION_DEFAULTS.map((entry) => [
        entry.id,
        {
          enabled: entry.enabled,
          grant: cloneGrant(entry.grant),
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
  };
}

export function defaultConfigYaml(): string {
  return (
    DEFAULT_CONFIG_HEADER +
    "extensions:\n" +
    FIRST_PARTY_EXTENSION_DEFAULTS.map(renderExtension).join("\n") +
    "\n" +
    DEFAULT_CONFIG_FOOTER
  );
}

function extension(
  id: string,
  enabled: boolean,
  grant: Readonly<Record<string, DefaultGrantValue>>,
): FirstPartyExtensionDefault {
  return Object.freeze({
    id,
    enabled,
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
    "    grant:",
    ...Object.entries(entry.grant).flatMap(([key, value]) =>
      renderGrantValue(key, value, 6),
    ),
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

function quote(value: string): string {
  return JSON.stringify(value);
}

const DEFAULT_CONFIG_HEADER = `# Dome vault configuration (v1.0).
#
# This file controls which extensions are active and their capability
# grants. The shipped first-party bundles (\`dome.daily\`, \`dome.graph\`,
# \`dome.health\`, \`dome.intake\`, \`dome.lint\`, \`dome.markdown\`,
# \`dome.search\`) live with the SDK. By default, CLI commands compose those
# shipped bundles with any vault-local bundles under \`.dome/extensions/\`.
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
