import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { err, ok, type Result } from "../types";
import type { ProcessorPhase } from "../core/processor";
import {
  buildProcessorExecutionState,
  type ProcessorExecutionState,
  type ProcessorExecutionStateEntry,
} from "../processors/execution-state";

export type OpenQuarantineStoreError =
  | { readonly kind: "quarantine-store-read-failed"; readonly cause: string }
  | { readonly kind: "quarantine-store-parse-failed"; readonly cause: string }
  | { readonly kind: "quarantine-store-write-failed"; readonly cause: string };

type QuarantineStoreFile = {
  readonly version: 1;
  readonly entries: ReadonlyArray<QuarantineStoreEntry>;
};

type QuarantineStoreEntry = {
  readonly phase: ProcessorPhase;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly triggerHash: string;
  readonly consecutiveRetryableFailures: number;
  readonly quarantineId?: string;
  readonly quarantinedAt?: string;
  readonly reason?: string;
};

export function openQuarantineStore(opts: {
  readonly path: string;
  readonly quarantineThreshold?: number;
}): Result<ProcessorExecutionState, OpenQuarantineStoreError> {
  const loaded = loadEntries(opts.path);
  if (!loaded.ok) return loaded;

  try {
    const state = buildProcessorExecutionState({
      initialEntries: loaded.value,
      ...(opts.quarantineThreshold !== undefined
        ? { quarantineThreshold: opts.quarantineThreshold }
        : {}),
      onEntriesChanged: (entries) => {
        writeEntries(opts.path, entries);
      },
    });
    return ok(state);
  } catch (e) {
    return err({
      kind: "quarantine-store-write-failed",
      cause: errorMessage(e),
    });
  }
}

function loadEntries(
  path: string,
): Result<
  ReadonlyArray<ProcessorExecutionStateEntry>,
  OpenQuarantineStoreError
> {
  if (!existsSync(path)) return ok(Object.freeze([]));

  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (e) {
    return err({
      kind: "quarantine-store-read-failed",
      cause: errorMessage(e),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return err({
      kind: "quarantine-store-parse-failed",
      cause: errorMessage(e),
    });
  }

  const entries = parseStoreFile(parsed);
  if (!entries.ok) {
    return err({
      kind: "quarantine-store-parse-failed",
      cause: entries.error,
    });
  }
  return ok(entries.value);
}

function writeEntries(
  path: string,
  entries: ReadonlyArray<ProcessorExecutionStateEntry>,
): void {
  const body: QuarantineStoreFile = Object.freeze({
    version: 1,
    entries: Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          phase: entry.phase,
          processorId: entry.processorId,
          processorVersion: entry.processorVersion,
          triggerHash: entry.triggerHash,
          consecutiveRetryableFailures:
            entry.consecutiveRetryableFailures,
          ...(entry.quarantineId !== undefined
            ? { quarantineId: entry.quarantineId }
            : {}),
          ...(entry.quarantinedAt !== undefined
            ? { quarantinedAt: entry.quarantinedAt.toISOString() }
            : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        }),
      ),
    ),
  });

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  writeFileSync(tempPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function parseStoreFile(
  value: unknown,
): Result<ReadonlyArray<ProcessorExecutionStateEntry>, string> {
  if (!isRecord(value)) {
    return err("quarantine store must be a JSON object");
  }
  if (value.version !== 1) {
    return err("quarantine store version must be 1");
  }
  if (!Array.isArray(value.entries)) {
    return err("quarantine store entries must be an array");
  }

  const entries: ProcessorExecutionStateEntry[] = [];
  for (let i = 0; i < value.entries.length; i += 1) {
    const entry = parseEntry(value.entries[i], i);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }
  return ok(Object.freeze(entries));
}

function parseEntry(
  value: unknown,
  index: number,
): Result<ProcessorExecutionStateEntry, string> {
  if (!isRecord(value)) {
    return err(`entries[${index}] must be an object`);
  }
  if (!isProcessorPhase(value.phase)) {
    return err(`entries[${index}].phase is invalid`);
  }
  if (typeof value.processorId !== "string" || value.processorId === "") {
    return err(`entries[${index}].processorId must be a non-empty string`);
  }
  if (
    typeof value.processorVersion !== "string" ||
    value.processorVersion === ""
  ) {
    return err(
      `entries[${index}].processorVersion must be a non-empty string`,
    );
  }
  if (typeof value.triggerHash !== "string" || value.triggerHash === "") {
    return err(`entries[${index}].triggerHash must be a non-empty string`);
  }
  if (
    typeof value.consecutiveRetryableFailures !== "number" ||
    !Number.isSafeInteger(value.consecutiveRetryableFailures) ||
    value.consecutiveRetryableFailures < 0
  ) {
    return err(
      `entries[${index}].consecutiveRetryableFailures must be a non-negative integer`,
    );
  }

  let quarantinedAt: Date | undefined;
  if (value.quarantineId !== undefined) {
    if (typeof value.quarantineId !== "string" || value.quarantineId === "") {
      return err(`entries[${index}].quarantineId must be a non-empty string`);
    }
  }
  if (value.quarantinedAt !== undefined) {
    if (typeof value.quarantinedAt !== "string") {
      return err(`entries[${index}].quarantinedAt must be a string`);
    }
    const parsed = new Date(value.quarantinedAt);
    if (Number.isNaN(parsed.getTime())) {
      return err(`entries[${index}].quarantinedAt must be an ISO date`);
    }
    quarantinedAt = parsed;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return err(`entries[${index}].reason must be a string`);
  }

  return ok(
    Object.freeze({
      phase: value.phase,
      processorId: value.processorId,
      processorVersion: value.processorVersion,
      triggerHash: value.triggerHash,
      consecutiveRetryableFailures: value.consecutiveRetryableFailures,
      ...(value.quarantineId !== undefined
        ? { quarantineId: value.quarantineId }
        : {}),
      ...(quarantinedAt !== undefined ? { quarantinedAt } : {}),
      ...(value.reason !== undefined ? { reason: value.reason } : {}),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProcessorPhase(value: unknown): value is ProcessorPhase {
  return value === "adoption" || value === "garden" || value === "view";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
