// capability-policy: vault config → runtime settings + effective bundle grants.
//
// Processors declare their requested capabilities in manifest.yaml. The
// vault grants capabilities in .dome/config.yaml under
// `extensions.<bundle>.grant` (or the documented plural `grants`), with
// optional replacement grants under `extensions.<bundle>.processors.<id>`. The
// broker receives the intersection: declaration from the processor, grant
// from this policy resolver. The same parse pass owns the small runtime
// config surface (`engine.max_iterations`, `*.auto_commit_workflows`) so
// generated config keys are either honored or rejected loudly.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { parse as parseYaml } from "yaml";

import {
  CapabilitySchema,
  type Capability,
  type ExtensionConfig,
} from "../../core/processor";
import type { ExecutionPolicyCap } from "../../processors/execution-policy";
import { err, ok, type Result } from "../../types";

export type CapabilityPolicy = {
  readonly foundConfig: boolean;
  readonly runtime: RuntimeConfig;
  readonly configuredExtensions: ReadonlyArray<ExtensionPolicyStatus>;
  readonly enabledExtensionIds: ReadonlyArray<string>;
  readonly isExtensionEnabled: (extensionId: string) => boolean;
  readonly grantsForExtension: (
    extensionId: string,
  ) => ReadonlyArray<Capability>;
  readonly processorGrantIdsForExtension: (
    extensionId: string,
  ) => ReadonlyArray<string>;
  /**
   * Resolved per-extension config: vault-level `shared_config:` keys merged
   * as defaults under the extension's own `config:` block (extension wins
   * per key). The shared block exists so cross-bundle keys like
   * `daily_path` are declared once instead of mirrored per extension.
   */
  readonly configForExtension: (extensionId: string) => ExtensionConfig;
  /** The raw vault-level `shared_config:` block (empty when absent). */
  readonly sharedConfig: ExtensionConfig;
  readonly grantsForProcessor: (
    extensionId: string,
    processorId: string,
  ) => ReadonlyArray<Capability>;
};

export type ExtensionPolicyStatus = {
  readonly id: string;
  readonly enabled: boolean;
};

export type RuntimeConfig = {
  readonly engine: {
    readonly maxIterations: number;
    readonly executionCap: ExecutionPolicyCap;
    readonly autoResolveQuestions: RuntimeQuestionAutoResolveConfig;
    /**
     * Per-attempt bound for external outbox handlers
     * (`engine.external_handler_timeout_ms`). Absent → the dispatch
     * layer's 30s default. Vaults whose subscription fetch commands run a
     * headless model (wiki/specs/sources.md §"The handler contract") raise
     * this.
     */
    readonly externalHandlerTimeoutMs?: number;
  };
  readonly git: {
    readonly auto_commit_workflows: boolean;
  };
  /**
   * Run-ledger housekeeping. Absent `retentionDays` means `dome serve`
   * never auto-prunes; `dome repair run-ledger` remains the manual path
   * regardless of this setting.
   */
  readonly ledger: {
    readonly retentionDays?: number;
  };
  readonly modelProvider?: RuntimeModelProviderConfig;
};

export type RuntimeModelProviderConfig = CommandModelProviderConfig;

export type RuntimeQuestionAutoResolveConfig = {
  readonly enabled: boolean;
  readonly policies: ReadonlyArray<"agent-safe" | "model-safe">;
  readonly minConfidence: number;
  readonly maxPerTick: number;
};

export type CommandModelProviderConfig = {
  readonly kind: "command";
  readonly command: ReadonlyArray<string>;
};

export function computeCapabilityPolicyHash(policy: CapabilityPolicy): string {
  const extensionIds = [...policy.enabledExtensionIds].sort();
  const extensionGrants = extensionIds.map((extensionId) => {
    const grants = serializeGrantSet(policy.grantsForExtension(extensionId));
    const processorGrants = [
      ...policy.processorGrantIdsForExtension(extensionId),
    ]
      .sort()
      .map((processorId) => ({
        processorId,
        grants: serializeGrantSet(
          policy.grantsForProcessor(extensionId, processorId),
        ),
      }));
    return {
      extensionId,
      config: stableJsonValue(policy.configForExtension(extensionId)),
      grants,
      processorGrants,
    };
  });
  return sha256(
    stableJsonStringify({
      foundConfig: policy.foundConfig,
      runtime: policy.runtime,
      sharedConfig: stableJsonValue(policy.sharedConfig),
      extensions: extensionGrants,
    }),
  );
}

export async function loadCapabilityPolicy(
  vaultPath: string,
): Promise<Result<CapabilityPolicy, string>> {
  const path = join(vaultPath, ".dome", "config.yaml");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (e) {
    if (isMissingFile(e)) {
      return ok(emptyPolicy(false));
    }
    return err(`failed to read ${path}: ${messageFor(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (e) {
    return err(`failed to parse ${path}: ${messageFor(e)}`);
  }

  const root = asRecord(parsed);
  if (root === null) {
    return err(`${path} must be a YAML mapping`);
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) {
      return err(`${path} ${key} is not a known top-level config field`);
    }
  }
  const runtimeConfig = parseRuntimeConfig(root, path);
  if (!runtimeConfig.ok) return err(runtimeConfig.error);

  const sharedConfig = parseExtensionConfig(root.shared_config, "shared_config");
  if (!sharedConfig.ok) return err(`${path} ${sharedConfig.error}`);

  const grants = new Map<string, ReadonlyArray<Capability>>();
  const processorGrants = new Map<
    string,
    ReadonlyMap<string, ReadonlyArray<Capability>>
  >();
  const extensionConfigs = new Map<string, ExtensionConfig>();
  const configuredExtensions: ExtensionPolicyStatus[] = [];
  const enabled = new Set<string>();
  if (root.extensions !== undefined) {
    const extensions = asRecord(root.extensions);
    if (extensions === null) {
      return err(`${path} extensions must be a YAML mapping`);
    }
    for (const [extensionId, rawExtension] of Object.entries(extensions)) {
      const extension = asRecord(rawExtension);
      const extensionPath = `extensions.${extensionId}`;
      if (extension === null) {
        return err(`${path} ${extensionPath} must be a YAML mapping`);
      }
      for (const key of Object.keys(extension)) {
        if (!EXTENSION_KEYS.has(key)) {
          return err(`${path} ${extensionPath}.${key} is not a known extension config field`);
        }
      }
      if (
        extension.enabled !== undefined &&
        typeof extension.enabled !== "boolean"
      ) {
        return err(`${path} ${extensionPath}.enabled must be a boolean`);
      }
      const parsedExtensionConfig = parseExtensionConfig(
        extension.config,
        `${extensionPath}.config`,
      );
      if (!parsedExtensionConfig.ok) {
        return err(`${path} ${parsedExtensionConfig.error}`);
      }
      extensionConfigs.set(extensionId, parsedExtensionConfig.value);
      const isEnabled = extension.enabled === true;
      configuredExtensions.push(Object.freeze({
        id: extensionId,
        enabled: isEnabled,
      }));
      if (!isEnabled) {
        grants.set(extensionId, Object.freeze([]));
        processorGrants.set(extensionId, new Map());
        continue;
      }
      enabled.add(extensionId);
      if (hasOwn(extension, "grant") && hasOwn(extension, "grants")) {
        return err(`${path} ${extensionPath} must use grant or grants, not both`);
      }
      const rawGrant = hasOwn(extension, "grant")
        ? extension.grant
        : extension.grants;
      const grantLabel = hasOwn(extension, "grant")
        ? `${extensionPath}.grant`
        : `${extensionPath}.grants`;
      const parsedGrant = parseGrantBlock(rawGrant, grantLabel);
      if (!parsedGrant.ok) {
        return err(`${path} ${parsedGrant.error}`);
      }
      grants.set(extensionId, parsedGrant.value);

      const parsedProcessorGrants = parseProcessorGrantOverrides(
        extension.processors,
        `${extensionPath}.processors`,
      );
      if (!parsedProcessorGrants.ok) {
        return err(`${path} ${parsedProcessorGrants.error}`);
      }
      processorGrants.set(extensionId, parsedProcessorGrants.value);
    }
  }

  return ok(
    Object.freeze({
      foundConfig: true,
      runtime: runtimeConfig.value,
      configuredExtensions: sortExtensionStatuses(configuredExtensions),
      enabledExtensionIds: Object.freeze([...enabled]),
      isExtensionEnabled: (extensionId: string) => enabled.has(extensionId),
      grantsForExtension: (extensionId: string) =>
        grants.get(extensionId) ?? Object.freeze([]),
      processorGrantIdsForExtension: (extensionId: string) =>
        Object.freeze([...(processorGrants.get(extensionId)?.keys() ?? [])]),
      configForExtension: mergedConfigResolver(
        sharedConfig.value,
        extensionConfigs,
      ),
      sharedConfig: sharedConfig.value,
      grantsForProcessor: (extensionId: string, processorId: string) =>
        processorGrants.get(extensionId)?.get(processorId) ??
        grants.get(extensionId) ??
        Object.freeze([]),
    }),
  );
}

function emptyPolicy(foundConfig: boolean): CapabilityPolicy {
  return Object.freeze({
    foundConfig,
    runtime: DEFAULT_RUNTIME_CONFIG,
    configuredExtensions: Object.freeze([]),
    enabledExtensionIds: Object.freeze([]),
    isExtensionEnabled: () => !foundConfig,
    grantsForExtension: () => Object.freeze([]),
    processorGrantIdsForExtension: () => Object.freeze([]),
    configForExtension: () => EMPTY_EXTENSION_CONFIG,
    sharedConfig: EMPTY_EXTENSION_CONFIG,
    grantsForProcessor: () => Object.freeze([]),
  });
}

function sortExtensionStatuses(
  statuses: ReadonlyArray<ExtensionPolicyStatus>,
): ReadonlyArray<ExtensionPolicyStatus> {
  return Object.freeze(
    [...statuses].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

function serializeGrantSet(grants: ReadonlyArray<Capability>): ReadonlyArray<unknown> {
  return Object.freeze(
    [...grants]
      .map(stableJsonStringify)
      .sort()
      .map((serialized) => JSON.parse(serialized) as unknown),
  );
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = stableJsonValue(record[key]);
  }
  return out;
}

function freezeConfigRecord(record: Record<string, unknown>): ExtensionConfig {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    out[key] = freezeConfigValue(record[key]);
  }
  return Object.freeze(out);
}

function freezeConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeConfigValue));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return freezeConfigRecord(value as Record<string, unknown>);
}

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  engine: Object.freeze({
    maxIterations: 100,
    executionCap: Object.freeze({}),
    autoResolveQuestions: Object.freeze({
      enabled: false,
      policies: Object.freeze(["agent-safe"] as const),
      minConfidence: 0.6,
      maxPerTick: 20,
    }),
  }),
  git: Object.freeze({
    auto_commit_workflows: true,
  }),
  ledger: Object.freeze({}),
});

const EMPTY_EXTENSION_CONFIG: ExtensionConfig = Object.freeze({});

/**
 * Build the `configForExtension` resolver: vault-level shared keys merged
 * as defaults under each extension's own config (extension wins per key).
 * Merged objects are memoized so repeated calls return stable identities.
 */
function mergedConfigResolver(
  shared: ExtensionConfig,
  extensionConfigs: ReadonlyMap<string, ExtensionConfig>,
): (extensionId: string) => ExtensionConfig {
  const sharedKeys = Object.keys(shared);
  const merged = new Map<string, ExtensionConfig>();
  return (extensionId: string): ExtensionConfig => {
    const own = extensionConfigs.get(extensionId);
    if (sharedKeys.length === 0) return own ?? EMPTY_EXTENSION_CONFIG;
    if (own === undefined || Object.keys(own).length === 0) return shared;
    const cached = merged.get(extensionId);
    if (cached !== undefined) return cached;
    const resolved: ExtensionConfig = Object.freeze({ ...shared, ...own });
    merged.set(extensionId, resolved);
    return resolved;
  };
}

const ROOT_KEYS = new Set([
  "extensions",
  "engine",
  "git",
  "ledger",
  "model_provider",
  "shared_config",
]);

const GRANT_KEYS = new Set([
  "read",
  "patch.propose",
  "patch.auto",
  "owns.path",
  "search.write",
  "graph.write",
  "question.ask",
  "model.invoke",
  "external",
  "outbox.read",
  "outbox.recover",
  "quarantine.read",
  "quarantine.recover",
  "run.read",
  "run.recover",
  "questions.read",
]);

const EXTENSION_KEYS = new Set([
  "enabled",
  "grant",
  "grants",
  "config",
  "processors",
]);
const PROCESSOR_KEYS = new Set(["grant", "grants"]);

const OUTBOX_STATUSES = ["pending", "sent", "failed", "abandoned"] as const;
const OUTBOX_RECOVERY_ACTIONS = ["retry", "abandon"] as const;
const QUARANTINE_RECOVERY_ACTIONS = ["reset"] as const;
const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "timed_out",
  "cancelled",
] as const;
const RUN_RECOVERY_ACTIONS = ["fail"] as const;

function parseRuntimeConfig(
  root: Record<string, unknown>,
  path: string,
): Result<RuntimeConfig, string> {
  const engine = root.engine === undefined ? {} : asRecord(root.engine);
  if (engine === null) return err(`${path} engine must be a YAML mapping`);
  const git = root.git === undefined ? {} : asRecord(root.git);
  if (git === null) return err(`${path} git must be a YAML mapping`);
  const ledger = root.ledger === undefined ? {} : asRecord(root.ledger);
  if (ledger === null) return err(`${path} ledger must be a YAML mapping`);
  const modelProvider = parseModelProviderConfig(
    root.model_provider,
    `${path} model_provider`,
  );
  if (!modelProvider.ok) return err(modelProvider.error);

  for (const key of Object.keys(engine)) {
    if (!ENGINE_KEYS.has(key)) {
      return err(`${path} engine.${key} is not a known engine config field`);
    }
  }
  for (const key of Object.keys(git)) {
    if (!GIT_KEYS.has(key)) {
      return err(`${path} git.${key} is not a known git config field`);
    }
  }
  for (const key of Object.keys(ledger)) {
    if (!LEDGER_KEYS.has(key)) {
      return err(`${path} ledger.${key} is not a known ledger config field`);
    }
  }

  const maxIterations = parsePositiveInteger(
    engine.max_iterations,
    `${path} engine.max_iterations`,
    DEFAULT_RUNTIME_CONFIG.engine.maxIterations,
  );
  if (!maxIterations.ok) return err(maxIterations.error);
  const processorTimeoutMs = parseOptionalPositiveInteger(
    engine.processor_timeout_ms,
    `${path} engine.processor_timeout_ms`,
  );
  if (!processorTimeoutMs.ok) return err(processorTimeoutMs.error);
  const modelCallTimeoutMs = parseOptionalPositiveInteger(
    engine.model_call_timeout_ms,
    `${path} engine.model_call_timeout_ms`,
  );
  if (!modelCallTimeoutMs.ok) return err(modelCallTimeoutMs.error);
  const externalHandlerTimeoutMs = parseOptionalPositiveInteger(
    engine.external_handler_timeout_ms,
    `${path} engine.external_handler_timeout_ms`,
  );
  if (!externalHandlerTimeoutMs.ok) return err(externalHandlerTimeoutMs.error);
  const ledgerRetentionDays = parseOptionalPositiveInteger(
    ledger.retention_days,
    `${path} ledger.retention_days`,
  );
  if (!ledgerRetentionDays.ok) return err(ledgerRetentionDays.error);

  const engineAutoCommit = parseOptionalBoolean(
    engine.auto_commit_workflows,
    `${path} engine.auto_commit_workflows`,
  );
  if (!engineAutoCommit.ok) return err(engineAutoCommit.error);
  const autoResolveQuestions = parseQuestionAutoResolveConfig(
    engine.auto_resolve_questions,
    `${path} engine.auto_resolve_questions`,
  );
  if (!autoResolveQuestions.ok) return err(autoResolveQuestions.error);
  const gitAutoCommit = parseOptionalBoolean(
    git.auto_commit_workflows,
    `${path} git.auto_commit_workflows`,
  );
  if (!gitAutoCommit.ok) return err(gitAutoCommit.error);
  if (
    engineAutoCommit.value !== undefined &&
    gitAutoCommit.value !== undefined &&
    engineAutoCommit.value !== gitAutoCommit.value
  ) {
    return err(
      `${path} engine.auto_commit_workflows and git.auto_commit_workflows must agree`,
    );
  }

  return ok(
    Object.freeze({
      engine: Object.freeze({
        maxIterations: maxIterations.value,
        executionCap: freezeExecutionCap({
          ...(processorTimeoutMs.value !== undefined
            ? { timeoutMs: processorTimeoutMs.value }
            : {}),
          ...(modelCallTimeoutMs.value !== undefined
            ? { modelCallTimeoutMs: modelCallTimeoutMs.value }
            : {}),
        }),
        autoResolveQuestions: autoResolveQuestions.value,
        ...(externalHandlerTimeoutMs.value !== undefined
          ? { externalHandlerTimeoutMs: externalHandlerTimeoutMs.value }
          : {}),
      }),
      git: Object.freeze({
        auto_commit_workflows:
          engineAutoCommit.value ??
          gitAutoCommit.value ??
          DEFAULT_RUNTIME_CONFIG.git.auto_commit_workflows,
      }),
      ledger: Object.freeze({
        ...(ledgerRetentionDays.value !== undefined
          ? { retentionDays: ledgerRetentionDays.value }
          : {}),
      }),
      ...(modelProvider.value !== undefined
        ? { modelProvider: modelProvider.value }
        : {}),
    }),
  );
}

function parseExtensionConfig(
  raw: unknown,
  label: string,
): Result<ExtensionConfig, string> {
  if (raw === undefined) return ok(EMPTY_EXTENSION_CONFIG);
  const config = asRecord(raw);
  if (config === null) return err(`${label} must be a YAML mapping`);
  return ok(freezeConfigRecord(config));
}

const ENGINE_KEYS = new Set([
  "max_iterations",
  "auto_commit_workflows",
  "processor_timeout_ms",
  "model_call_timeout_ms",
  "external_handler_timeout_ms",
  "auto_resolve_questions",
]);
const GIT_KEYS = new Set(["auto_commit_workflows"]);
const LEDGER_KEYS = new Set(["retention_days"]);

function parseModelProviderConfig(
  raw: unknown,
  label: string,
): Result<RuntimeModelProviderConfig | undefined, string> {
  if (raw === undefined) return ok(undefined);
  const provider = asRecord(raw);
  if (provider === null) return err(`${label} must be a YAML mapping`);
  for (const key of Object.keys(provider)) {
    if (!MODEL_PROVIDER_KEYS.has(key)) {
      return err(`${label}.${key} is not a known model_provider field`);
    }
  }
  if (provider.kind !== "command") {
    return err(`${label}.kind must be "command"`);
  }
  const command = readRequiredStringList(provider.command, `${label}.command`);
  if (!command.ok) return command;
  return ok(
    Object.freeze({
      kind: "command",
      command: command.value,
    }),
  );
}

const MODEL_PROVIDER_KEYS = new Set(["kind", "command"]);
const QUESTION_AUTO_RESOLVE_KEYS = new Set([
  "enabled",
  "policies",
  "min_confidence",
  "max_per_tick",
]);
const QUESTION_AUTO_RESOLVE_POLICIES = new Set(["agent-safe", "model-safe"]);

function parseQuestionAutoResolveConfig(
  raw: unknown,
  label: string,
): Result<RuntimeQuestionAutoResolveConfig, string> {
  const fallback = DEFAULT_RUNTIME_CONFIG.engine.autoResolveQuestions;
  if (raw === undefined) return ok(fallback);
  const config = asRecord(raw);
  if (config === null) return err(`${label} must be a YAML mapping`);
  for (const key of Object.keys(config)) {
    if (!QUESTION_AUTO_RESOLVE_KEYS.has(key)) {
      return err(`${label}.${key} is not a known auto_resolve_questions field`);
    }
  }

  const enabled = parseOptionalBoolean(config.enabled, `${label}.enabled`);
  if (!enabled.ok) return err(enabled.error);

  const policies =
    config.policies === undefined
      ? ok(fallback.policies)
      : readRequiredStringList(config.policies, `${label}.policies`);
  if (!policies.ok) return err(policies.error);
  const normalizedPolicies: Array<"agent-safe" | "model-safe"> = [];
  for (const policy of policies.value) {
    if (!QUESTION_AUTO_RESOLVE_POLICIES.has(policy)) {
      return err(
        `${label}.policies[] must be one of "agent-safe", "model-safe"`,
      );
    }
    if (!normalizedPolicies.includes(policy as "agent-safe" | "model-safe")) {
      normalizedPolicies.push(policy as "agent-safe" | "model-safe");
    }
  }

  const minConfidence =
    config.min_confidence === undefined
      ? ok(fallback.minConfidence)
      : parseConfidence(config.min_confidence, `${label}.min_confidence`);
  if (!minConfidence.ok) return err(minConfidence.error);

  const maxPerTick = parsePositiveInteger(
    config.max_per_tick,
    `${label}.max_per_tick`,
    fallback.maxPerTick,
  );
  if (!maxPerTick.ok) return err(maxPerTick.error);

  return ok(
    Object.freeze({
      enabled: enabled.value ?? fallback.enabled,
      policies: Object.freeze(normalizedPolicies),
      minConfidence: minConfidence.value,
      maxPerTick: maxPerTick.value,
    }),
  );
}

function parseConfidence(raw: unknown, label: string): Result<number, string> {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return err(`${label} must be a number between 0 and 1`);
  }
  return ok(raw);
}

function parsePositiveInteger(
  raw: unknown,
  label: string,
  fallback: number,
): Result<number, string> {
  if (raw === undefined) return ok(fallback);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    return err(`${label} must be a positive integer`);
  }
  return ok(raw);
}

function parseOptionalPositiveInteger(
  raw: unknown,
  label: string,
): Result<number | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    return err(`${label} must be a positive integer`);
  }
  return ok(raw);
}

function freezeExecutionCap(cap: ExecutionPolicyCap): ExecutionPolicyCap {
  return Object.freeze({ ...cap });
}

function parseOptionalBoolean(
  raw: unknown,
  label: string,
): Result<boolean | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== "boolean") return err(`${label} must be a boolean`);
  return ok(raw);
}

function parseGrantBlock(
  raw: unknown,
  label: string,
): Result<ReadonlyArray<Capability>, string> {
  if (raw === undefined) return ok(Object.freeze([]));

  const grant = asRecord(raw);
  if (grant === null) return err(`${label} must be a YAML mapping`);

  for (const key of Object.keys(grant)) {
    if (!GRANT_KEYS.has(key)) {
      return err(`${label}.${key} is not a known capability grant`);
    }
  }

  const capabilities: Capability[] = [];
  for (const [key, value] of Object.entries(grant)) {
    const normalized = normalizeGrantEntry(key, value, `${label}.${key}`);
    if (!normalized.ok) return normalized;

    for (const candidate of normalized.value) {
      const parsed = CapabilitySchema.safeParse(candidate);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "is malformed";
        return err(`${label}.${key} ${message}`);
      }
      capabilities.push(parsed.data as Capability);
    }
  }

  return ok(Object.freeze(capabilities));
}

function parseProcessorGrantOverrides(
  raw: unknown,
  label: string,
): Result<ReadonlyMap<string, ReadonlyArray<Capability>>, string> {
  if (raw === undefined) return ok(Object.freeze(new Map()));

  const processors = asRecord(raw);
  if (processors === null) return err(`${label} must be a YAML mapping`);

  const out = new Map<string, ReadonlyArray<Capability>>();
  for (const [processorId, rawProcessor] of Object.entries(processors)) {
    const processor = asRecord(rawProcessor);
    const processorLabel = `${label}.${processorId}`;
    if (processor === null) {
      return err(`${processorLabel} must be a YAML mapping`);
    }
    for (const key of Object.keys(processor)) {
      if (!PROCESSOR_KEYS.has(key)) {
        return err(`${processorLabel}.${key} is not a known processor config field`);
      }
    }
    if (hasOwn(processor, "grant") && hasOwn(processor, "grants")) {
      return err(`${processorLabel} must use grant or grants, not both`);
    }
    const rawGrant = hasOwn(processor, "grant")
      ? processor.grant
      : processor.grants;
    const grantLabel = hasOwn(processor, "grant")
      ? `${processorLabel}.grant`
      : `${processorLabel}.grants`;
    const parsedGrant = parseGrantBlock(rawGrant, grantLabel);
    if (!parsedGrant.ok) return parsedGrant;
    out.set(processorId, parsedGrant.value);
  }

  return ok(Object.freeze(out));
}

const STRING_LIST_GRANTS: Record<
  string,
  {
    readonly kind:
      | "read"
      | "patch.propose"
      | "patch.auto"
      | "owns.path"
      | "search.write"
      | "graph.write";
    readonly field: "paths" | "regionIds" | "namespaces";
  }
> = {
  read: { kind: "read", field: "paths" },
  "patch.propose": { kind: "patch.propose", field: "paths" },
  "patch.auto": { kind: "patch.auto", field: "paths" },
  "owns.path": { kind: "owns.path", field: "paths" },
  "search.write": { kind: "search.write", field: "paths" },
  "graph.write": { kind: "graph.write", field: "namespaces" },
};

function normalizeGrantEntry(
  key: string,
  raw: unknown,
  label: string,
): Result<ReadonlyArray<unknown>, string> {
  const listGrant = STRING_LIST_GRANTS[key];
  if (listGrant !== undefined) {
    const values = readRequiredStringList(raw, label);
    if (!values.ok) return values;
    return ok([{ kind: listGrant.kind, [listGrant.field]: values.value }]);
  }

  switch (key) {
    case "question.ask":
      return normalizeQuestionAsk(raw, label);
    case "model.invoke":
      return normalizeModelInvoke(raw, label);
    case "external":
      return normalizeExternal(raw, label);
    case "outbox.read":
      return normalizeEnumCapability(
        raw,
        label,
        "outbox.read",
        "statuses",
        OUTBOX_STATUSES,
      );
    case "outbox.recover":
      return normalizeEnumCapability(
        raw,
        label,
        "outbox.recover",
        "actions",
        OUTBOX_RECOVERY_ACTIONS,
      );
    case "quarantine.read":
      if (raw !== true) return err(`${label} must be true`);
      return ok([{ kind: "quarantine.read" }]);
    case "questions.read":
      if (raw !== true) return err(`${label} must be true`);
      return ok([{ kind: "questions.read" }]);
    case "quarantine.recover":
      return normalizeEnumCapability(
        raw,
        label,
        "quarantine.recover",
        "actions",
        QUARANTINE_RECOVERY_ACTIONS,
      );
    case "run.read":
      return normalizeEnumCapability(
        raw,
        label,
        "run.read",
        "statuses",
        RUN_STATUSES,
      );
    case "run.recover":
      return normalizeEnumCapability(
        raw,
        label,
        "run.recover",
        "actions",
        RUN_RECOVERY_ACTIONS,
      );
    default:
      return err(`${label} is not a known capability grant`);
  }
}

function normalizeQuestionAsk(
  raw: unknown,
  label: string,
): Result<ReadonlyArray<unknown>, string> {
  if (raw === true) return ok([{ kind: "question.ask" }]);
  return err(`${label} must be true`);
}

function normalizeModelInvoke(
  raw: unknown,
  label: string,
): Result<ReadonlyArray<unknown>, string> {
  if (raw === true) return ok([{ kind: "model.invoke" }]);

  const grant = asRecord(raw);
  if (grant === null) return err(`${label} must be true or a YAML mapping`);
  for (const key of Object.keys(grant)) {
    if (key !== "maxDailyCostUsd" && key !== "modelAllowlist") {
      return err(`${label}.${key} is not a known model.invoke grant field`);
    }
  }
  const built: {
    kind: "model.invoke";
    maxDailyCostUsd?: number;
    modelAllowlist?: ReadonlyArray<string>;
  } = { kind: "model.invoke" };

  if (grant.maxDailyCostUsd !== undefined) {
    if (
      typeof grant.maxDailyCostUsd !== "number" ||
      !Number.isFinite(grant.maxDailyCostUsd) ||
      grant.maxDailyCostUsd < 0
    ) {
      return err(`${label}.maxDailyCostUsd must be a non-negative number`);
    }
    built.maxDailyCostUsd = grant.maxDailyCostUsd;
  }

  const modelAllowlist =
    grant.modelAllowlist === undefined
      ? ok(undefined)
      : readRequiredStringList(grant.modelAllowlist, `${label}.modelAllowlist`);
  if (!modelAllowlist.ok) return modelAllowlist;
  if (modelAllowlist.value !== undefined) {
    built.modelAllowlist = modelAllowlist.value;
  }

  return ok([built]);
}

function normalizeExternal(
  raw: unknown,
  label: string,
): Result<ReadonlyArray<unknown>, string> {
  const capabilities = readRequiredStringList(raw, label);
  if (!capabilities.ok) return capabilities;
  return ok(
    capabilities.value.map((capability) => ({
      kind: "external",
      capability,
    })),
  );
}

function normalizeEnumCapability<Allowed extends readonly string[]>(
  raw: unknown,
  label: string,
  kind:
    | "outbox.read"
    | "outbox.recover"
    | "quarantine.recover"
    | "run.read"
    | "run.recover",
  field: "statuses" | "actions",
  allowed: Allowed,
): Result<ReadonlyArray<unknown>, string> {
  if (raw === true) {
    if (field === "statuses") return ok([{ kind }]);
    return ok([{ kind, [field]: [...allowed] }]);
  }
  const values = readRequiredEnumList(raw, allowed, label);
  if (!values.ok) return values;
  return ok([{ kind, [field]: values.value }]);
}

function readRequiredStringList(
  raw: unknown,
  label: string,
): Result<ReadonlyArray<string>, string> {
  if (typeof raw === "string") {
    if (raw.trim().length === 0) {
      return err(`${label} must not be an empty string`);
    }
    return ok(Object.freeze([raw]));
  }
  if (!Array.isArray(raw)) {
    return err(`${label} must be a string or non-empty string array`);
  }
  if (raw.length === 0) {
    return err(`${label} must be a non-empty string array`);
  }
  const values: string[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return err(`${label}[${index}] must be a non-empty string`);
    }
    values.push(value);
  }
  return ok(Object.freeze(values));
}

function readRequiredEnumList<Allowed extends readonly string[]>(
  raw: unknown,
  allowed: Allowed,
  label: string,
): Result<ReadonlyArray<Allowed[number]>, string> {
  const values = readRequiredStringList(raw, label);
  if (!values.ok) return values;
  for (const [index, value] of values.value.entries()) {
    if (!allowed.includes(value)) {
      return err(
        `${label}[${index}] must be one of ${allowed.map((s) => `"${s}"`).join(", ")}`,
      );
    }
  }
  return ok(Object.freeze(values.value as ReadonlyArray<Allowed[number]>));
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isMissingFile(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code?: unknown }).code === "ENOENT"
  );
}

function messageFor(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
