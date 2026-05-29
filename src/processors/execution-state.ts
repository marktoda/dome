import { createHash, randomUUID } from "node:crypto";

import type { ProcessorPhase } from "../core/processor";
import type { TriggerMatch } from "./triggers";

export const DEFAULT_QUARANTINE_THRESHOLD = 3;

export type ProcessorExecutionKey = {
  readonly phase: ProcessorPhase;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly triggerHash: string;
};

export type ProcessorExecutionStateEntry = ProcessorExecutionKey & {
  readonly consecutiveRetryableFailures: number;
  readonly quarantineId?: string;
  readonly quarantinedAt?: Date;
  readonly reason?: string;
};

export type ProcessorQuarantineSnapshot = {
  readonly key: ProcessorExecutionKey;
  readonly quarantineId: string;
  readonly consecutiveRetryableFailures: number;
  readonly quarantinedAt: Date;
  readonly reason: string;
};

export type ProcessorQuarantineClearExpectation = ProcessorExecutionKey & {
  readonly quarantineId: string;
  readonly consecutiveRetryableFailures: number;
  readonly quarantinedAt: Date;
};

export type ProcessorExecutionState = {
  readonly quarantines: () => ReadonlyArray<ProcessorQuarantineSnapshot>;
  readonly quarantineFor: (
    key: ProcessorExecutionKey,
  ) => ProcessorQuarantineSnapshot | null;
  readonly recordSuccess: (key: ProcessorExecutionKey) => void;
  readonly recordNonRetryableTerminalFailure: (
    key: ProcessorExecutionKey,
  ) => void;
  readonly recordRetryableTerminalFailure: (
    key: ProcessorExecutionKey,
    reason: string,
  ) => ProcessorQuarantineSnapshot | null;
  readonly clearQuarantine: (key: ProcessorExecutionKey) => void;
  readonly clearQuarantineIfCurrent: (
    expected: ProcessorQuarantineClearExpectation,
  ) => boolean;
};

type MutableEntry = {
  consecutiveRetryableFailures: number;
  quarantineId?: string;
  quarantinedAt?: Date;
  reason?: string;
};

export function buildProcessorExecutionState(opts?: {
  readonly quarantineThreshold?: number;
  readonly initialEntries?: ReadonlyArray<ProcessorExecutionStateEntry>;
  readonly onEntriesChanged?: (
    entries: ReadonlyArray<ProcessorExecutionStateEntry>,
  ) => void;
}): ProcessorExecutionState {
  const threshold =
    opts?.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
  const entries = new Map<string, MutableEntry>();
  for (const entry of opts?.initialEntries ?? []) {
    const mutable: MutableEntry = {
      consecutiveRetryableFailures: entry.consecutiveRetryableFailures,
      ...(entry.quarantinedAt !== undefined
        ? { quarantinedAt: new Date(entry.quarantinedAt.getTime()) }
        : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
    if (entry.quarantineId !== undefined) {
      mutable.quarantineId = entry.quarantineId;
    } else if (
      mutable.quarantinedAt !== undefined &&
      mutable.reason !== undefined
    ) {
      mutable.quarantineId = legacyQuarantineId(entry, mutable);
    }
    entries.set(keyId(entry), mutable);
  }

  const persist = (): void => {
    opts?.onEntriesChanged?.(snapshotEntries(entries));
  };

  const quarantineFor = (
    key: ProcessorExecutionKey,
  ): ProcessorQuarantineSnapshot | null => {
    const entry = entries.get(keyId(key));
    if (
      entry === undefined ||
      entry.quarantinedAt === undefined ||
      entry.reason === undefined
    ) {
      return null;
    }
    return freezeSnapshot(key, {
      quarantineId:
        entry.quarantineId ?? legacyQuarantineId(key, entry),
      consecutiveRetryableFailures:
        entry.consecutiveRetryableFailures,
      quarantinedAt: entry.quarantinedAt,
      reason: entry.reason,
    });
  };

  return Object.freeze({
    quarantines: () => quarantineSnapshots(entries),
    quarantineFor,
    recordSuccess: (key) => {
      if (entries.delete(keyId(key))) persist();
    },
    recordNonRetryableTerminalFailure: (key) => {
      if (entries.delete(keyId(key))) persist();
    },
    recordRetryableTerminalFailure: (key, reason) => {
      const id = keyId(key);
      const entry =
        entries.get(id) ?? { consecutiveRetryableFailures: 0 };
      entry.consecutiveRetryableFailures += 1;
      if (
        entry.consecutiveRetryableFailures >= threshold &&
        entry.quarantinedAt === undefined
      ) {
        entry.quarantineId = randomUUID();
        entry.quarantinedAt = new Date();
        entry.reason = reason;
      }
      entries.set(id, entry);
      persist();
      return quarantineFor(key);
    },
    clearQuarantine: (key) => {
      if (entries.delete(keyId(key))) persist();
    },
    clearQuarantineIfCurrent: (expected) => {
      const id = keyId(expected);
      const entry = entries.get(id);
      if (
        entry?.quarantinedAt === undefined ||
        entry.quarantineId !== expected.quarantineId ||
        entry.consecutiveRetryableFailures !==
          expected.consecutiveRetryableFailures ||
        entry.quarantinedAt.toISOString() !==
          expected.quarantinedAt.toISOString()
      ) {
        return false;
      }
      entries.delete(id);
      persist();
      return true;
    },
  });
}

export function processorExecutionKey(input: {
  readonly phase: ProcessorPhase;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly matches: ReadonlyArray<TriggerMatch>;
}): ProcessorExecutionKey {
  return Object.freeze({
    phase: input.phase,
    processorId: input.processorId,
    processorVersion: input.processorVersion,
    triggerHash: createHash("sha256")
      .update(JSON.stringify(triggerPayloadOf(input.matches)))
      .digest("hex"),
  });
}

function triggerPayloadOf(
  matches: ReadonlyArray<TriggerMatch>,
): ReadonlyArray<{
  readonly trigger: TriggerMatch["trigger"];
  readonly matchedSignals: TriggerMatch["matchedSignals"];
}> {
  return matches.map((m) => ({
    trigger: m.trigger,
    matchedSignals: m.matchedSignals,
  }));
}

function keyId(key: ProcessorExecutionKey): string {
  return [
    key.phase,
    key.processorId,
    key.processorVersion,
    key.triggerHash,
  ].join("\0");
}

function freezeSnapshot(
  key: ProcessorExecutionKey,
  entry: {
    readonly quarantineId: string;
    readonly consecutiveRetryableFailures: number;
    readonly quarantinedAt: Date;
    readonly reason: string;
  },
): ProcessorQuarantineSnapshot {
  return Object.freeze({
    key,
    quarantineId: entry.quarantineId,
    consecutiveRetryableFailures: entry.consecutiveRetryableFailures,
    quarantinedAt: new Date(entry.quarantinedAt.getTime()),
    reason: entry.reason,
  });
}

function snapshotEntries(
  entries: ReadonlyMap<string, MutableEntry>,
): ReadonlyArray<ProcessorExecutionStateEntry> {
  const out: ProcessorExecutionStateEntry[] = [];
  for (const [id, entry] of entries) {
    const [phase, processorId, processorVersion, triggerHash] = id.split("\0");
    if (
      phase !== "adoption" &&
      phase !== "garden" &&
      phase !== "view"
    ) {
      continue;
    }
    if (
      processorId === undefined ||
      processorVersion === undefined ||
      triggerHash === undefined
    ) {
      continue;
    }
    out.push(
      Object.freeze({
        phase,
        processorId,
        processorVersion,
        triggerHash,
        consecutiveRetryableFailures:
          entry.consecutiveRetryableFailures,
        ...(entry.quarantineId !== undefined
          ? { quarantineId: entry.quarantineId }
          : {}),
        ...(entry.quarantinedAt !== undefined
          ? { quarantinedAt: new Date(entry.quarantinedAt.getTime()) }
          : {}),
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      }),
    );
  }
  out.sort((a, b) => keyId(a).localeCompare(keyId(b)));
  return Object.freeze(out);
}

function quarantineSnapshots(
  entries: ReadonlyMap<string, MutableEntry>,
): ReadonlyArray<ProcessorQuarantineSnapshot> {
  const out: ProcessorQuarantineSnapshot[] = [];
  for (const entry of snapshotEntries(entries)) {
    if (entry.quarantinedAt === undefined || entry.reason === undefined) {
      continue;
    }
    out.push(
      freezeSnapshot(entry, {
        quarantineId:
          entry.quarantineId ?? legacyQuarantineId(entry, entry),
        consecutiveRetryableFailures:
          entry.consecutiveRetryableFailures,
        quarantinedAt: entry.quarantinedAt,
        reason: entry.reason,
      }),
    );
  }
  return Object.freeze(out);
}

function legacyQuarantineId(
  key: ProcessorExecutionKey,
  entry: {
    readonly consecutiveRetryableFailures: number;
    readonly quarantinedAt?: Date;
    readonly reason?: string;
  },
): string {
  return `legacy-${createHash("sha256")
    .update(
      JSON.stringify([
        key.phase,
        key.processorId,
        key.processorVersion,
        key.triggerHash,
        entry.quarantinedAt?.toISOString() ?? "",
        entry.consecutiveRetryableFailures,
        entry.reason ?? "",
      ]),
    )
    .digest("hex")}`;
}
