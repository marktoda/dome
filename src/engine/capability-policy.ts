// capability-policy: vault config → runtime settings + effective bundle grants.
//
// Processors declare their requested capabilities in manifest.yaml. The
// vault grants capabilities in .dome/config.yaml under
// `extensions.<bundle>.grant` (or the documented plural `grants`). The
// broker receives the intersection: declaration from the processor, grant
// from this policy resolver. The same parse pass owns the small runtime
// config surface (`engine.max_iterations`, `*.auto_commit_workflows`) so
// generated config keys are either honored or rejected loudly.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { CapabilitySchema, type Capability } from "../core/processor";
import type { ExecutionPolicyCap } from "../processors/execution-policy";
import { err, ok, type Result } from "../types";

export type CapabilityPolicy = {
  readonly foundConfig: boolean;
  readonly runtime: RuntimeConfig;
  readonly enabledExtensionIds: ReadonlyArray<string>;
  readonly isExtensionEnabled: (extensionId: string) => boolean;
  readonly grantsForExtension: (
    extensionId: string,
  ) => ReadonlyArray<Capability>;
};

export type RuntimeConfig = {
  readonly engine: {
    readonly maxIterations: number;
    readonly executionCap: ExecutionPolicyCap;
  };
  readonly git: {
    readonly auto_commit_workflows: boolean;
  };
};

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

  const grants = new Map<string, ReadonlyArray<Capability>>();
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
      if (extension.config !== undefined && asRecord(extension.config) === null) {
        return err(`${path} ${extensionPath}.config must be a YAML mapping`);
      }
      if (extension.enabled !== true) {
        grants.set(extensionId, Object.freeze([]));
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
    }
  }

  return ok(
    Object.freeze({
      foundConfig: true,
      runtime: runtimeConfig.value,
      enabledExtensionIds: Object.freeze([...enabled]),
      isExtensionEnabled: (extensionId: string) => enabled.has(extensionId),
      grantsForExtension: (extensionId: string) =>
        grants.get(extensionId) ?? Object.freeze([]),
    }),
  );
}

function emptyPolicy(foundConfig: boolean): CapabilityPolicy {
  return Object.freeze({
    foundConfig,
    runtime: DEFAULT_RUNTIME_CONFIG,
    enabledExtensionIds: Object.freeze([]),
    isExtensionEnabled: () => !foundConfig,
    grantsForExtension: () => Object.freeze([]),
  });
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  engine: Object.freeze({
    maxIterations: 100,
    executionCap: Object.freeze({}),
  }),
  git: Object.freeze({
    auto_commit_workflows: true,
  }),
});

const ROOT_KEYS = new Set(["extensions", "engine", "git"]);

const GRANT_KEYS = new Set([
  "read",
  "patch.propose",
  "patch.auto",
  "owns.path",
  "search.write",
  "owns.region",
  "graph.write",
  "question.ask",
  "job.enqueue",
  "model.invoke",
  "external",
  "outbox.read",
  "outbox.recover",
  "quarantine.read",
  "quarantine.recover",
  "run.read",
  "run.recover",
]);

const EXTENSION_KEYS = new Set(["enabled", "grant", "grants", "config"]);

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

  const engineAutoCommit = parseOptionalBoolean(
    engine.auto_commit_workflows,
    `${path} engine.auto_commit_workflows`,
  );
  if (!engineAutoCommit.ok) return err(engineAutoCommit.error);
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
      }),
      git: Object.freeze({
        auto_commit_workflows:
          engineAutoCommit.value ??
          gitAutoCommit.value ??
          DEFAULT_RUNTIME_CONFIG.git.auto_commit_workflows,
      }),
    }),
  );
}

const ENGINE_KEYS = new Set([
  "max_iterations",
  "auto_commit_workflows",
  "processor_timeout_ms",
  "model_call_timeout_ms",
]);
const GIT_KEYS = new Set(["auto_commit_workflows"]);

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

const STRING_LIST_GRANTS: Record<
  string,
  {
    readonly kind:
      | "read"
      | "patch.propose"
      | "patch.auto"
      | "owns.path"
      | "search.write"
      | "owns.region"
      | "graph.write"
      | "job.enqueue";
    readonly field: "paths" | "regionIds" | "namespaces" | "processors";
  }
> = {
  read: { kind: "read", field: "paths" },
  "patch.propose": { kind: "patch.propose", field: "paths" },
  "patch.auto": { kind: "patch.auto", field: "paths" },
  "owns.path": { kind: "owns.path", field: "paths" },
  "search.write": { kind: "search.write", field: "paths" },
  "owns.region": { kind: "owns.region", field: "regionIds" },
  "graph.write": { kind: "graph.write", field: "namespaces" },
  "job.enqueue": { kind: "job.enqueue", field: "processors" },
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
  const namespaces = readRequiredStringList(raw, label);
  if (!namespaces.ok) return namespaces;
  return ok([{ kind: "question.ask", namespaces: namespaces.value }]);
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
