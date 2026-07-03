import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { err, ok, type Result } from "../../types";
import { ProcessorPhaseSchema } from "../../core/processor";
import {
  buildProcessorExecutionState,
  type ProcessorExecutionState,
  type ProcessorExecutionStateEntry,
} from "../../processors/execution-state";

export type OpenQuarantineStoreError =
  | { readonly kind: "quarantine-store-read-failed"; readonly cause: string }
  | { readonly kind: "quarantine-store-parse-failed"; readonly cause: string }
  | { readonly kind: "quarantine-store-write-failed"; readonly cause: string };

type QuarantineStoreFile = {
  readonly version: 1;
  readonly entries: ReadonlyArray<QuarantineStoreEntry>;
};

type QuarantineStoreEntry = {
  readonly phase: z.infer<typeof ProcessorPhaseSchema>;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly triggerHash: string;
  readonly consecutiveRetryableFailures: number;
  readonly quarantineId?: string;
  readonly quarantinedAt?: string;
  readonly reason?: string;
};

const QuarantineStoreEntrySchema = z.object({
  phase: ProcessorPhaseSchema,
  processorId: z.string().min(1),
  processorVersion: z.string().min(1),
  triggerHash: z.string().min(1),
  consecutiveRetryableFailures: z.number().int().nonnegative(),
  quarantineId: z.string().min(1).optional(),
  quarantinedAt: z.string().datetime().optional(),
  reason: z.string().optional(),
}).strict();

const QuarantineStoreFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(QuarantineStoreEntrySchema),
}).strict();

export function openQuarantineStore(opts: {
  readonly path: string;
  readonly quarantineThreshold?: number;
  /**
   * Fired only when the QUARANTINE SET changes (threshold-trip or clear) — see
   * `buildProcessorExecutionState`. The host wires this to its tick-scoped
   * `quarantine.changed` flag.
   */
  readonly onQuarantineChanged?: () => void;
}): Result<ProcessorExecutionState, OpenQuarantineStoreError> {
  const loaded = loadEntries(opts.path);
  if (!loaded.ok) return loaded;

  try {
    const state = buildProcessorExecutionState({
      initialEntries: loaded.value,
      ...(opts.quarantineThreshold !== undefined
        ? { quarantineThreshold: opts.quarantineThreshold }
        : {}),
      ...(opts.onQuarantineChanged !== undefined
        ? { onQuarantineChanged: opts.onQuarantineChanged }
        : {}),
      onEntriesChanged: (entries) => {
        writeEntries(opts.path, entries);
      },
      // Cross-process freshness: re-read the file before every read and
      // mutation so concurrently-open runtimes (dome serve beside dome
      // resolve / run / view commands) see each other's counters and
      // clears instead of clobbering them with stale open-time snapshots.
      // A failed reload (e.g. a concurrent writer mid-corruption) returns
      // null and the state keeps serving its last good entries.
      reloadEntries: () => {
        const reloaded = loadEntries(opts.path);
        return reloaded.ok ? reloaded.value : null;
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
  const parsed = QuarantineStoreFileSchema.safeParse(value);
  if (!parsed.success) {
    return err(formatZodError(parsed.error));
  }

  return ok(Object.freeze(parsed.data.entries.map(entryFromParsed)));
}

function entryFromParsed(
  entry: z.infer<typeof QuarantineStoreEntrySchema>,
): ProcessorExecutionStateEntry {
  return Object.freeze({
    phase: entry.phase,
    processorId: entry.processorId,
    processorVersion: entry.processorVersion,
    triggerHash: entry.triggerHash,
    consecutiveRetryableFailures: entry.consecutiveRetryableFailures,
    ...(entry.quarantineId !== undefined
      ? { quarantineId: entry.quarantineId }
      : {}),
    ...(entry.quarantinedAt !== undefined
      ? { quarantinedAt: new Date(entry.quarantinedAt) }
      : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  });
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "quarantine store failed validation";
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
