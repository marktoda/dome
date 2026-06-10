import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openQuarantineStore } from "../../src/engine/quarantine-store";
import type { ProcessorExecutionKey } from "../../src/processors/execution-state";

describe("quarantine store", () => {
  test("persists retryable failure counters and quarantine state", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-quarantine-store-"));
    try {
      const path = join(root, ".dome", "state", "quarantined.json");
      const opened = openQuarantineStore({
        path,
        quarantineThreshold: 2,
      });
      if (!opened.ok) throw new Error(opened.error.kind);

      const key: ProcessorExecutionKey = Object.freeze({
        phase: "garden",
        processorId: "test.processor",
        processorVersion: "0.0.1",
        triggerHash: "abc123",
      });

      expect(
        opened.value.recordRetryableTerminalFailure(key, "first"),
      ).toBeNull();
      const quarantine =
        opened.value.recordRetryableTerminalFailure(key, "second");
      expect(quarantine?.consecutiveRetryableFailures).toBe(2);
      expect(opened.value.quarantines().length).toBe(1);

      const body = JSON.parse(await readFile(path, "utf8"));
      expect(body.version).toBe(1);
      expect(body.entries[0].processorId).toBe("test.processor");
      expect(body.entries[0].quarantineId).toEqual(expect.any(String));
      expect(body.entries[0].quarantinedAt).toEqual(expect.any(String));

      const reopened = openQuarantineStore({
        path,
        quarantineThreshold: 2,
      });
      if (!reopened.ok) throw new Error(reopened.error.kind);
      expect(
        reopened.value.quarantineFor(key)?.consecutiveRetryableFailures,
      ).toBe(2);
      expect(reopened.value.quarantines()[0]?.key.processorId).toBe(
        "test.processor",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearQuarantineIfCurrent refuses stale quarantine generations", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-quarantine-store-"));
    try {
      const path = join(root, ".dome", "state", "quarantined.json");
      const opened = openQuarantineStore({
        path,
        quarantineThreshold: 1,
      });
      if (!opened.ok) throw new Error(opened.error.kind);
      const key: ProcessorExecutionKey = Object.freeze({
        phase: "garden",
        processorId: "test.processor",
        processorVersion: "0.0.1",
        triggerHash: "abc123",
      });

      const current = opened.value.recordRetryableTerminalFailure(key, "boom");
      if (current === null) throw new Error("expected quarantine");
      expect(
        opened.value.clearQuarantineIfCurrent({
          ...key,
          quarantineId: "stale-generation",
          quarantinedAt: current.quarantinedAt,
          consecutiveRetryableFailures:
            current.consecutiveRetryableFailures,
        }),
      ).toBe(false);
      expect(opened.value.quarantineFor(key)?.quarantineId).toBe(
        current.quarantineId,
      );

      expect(
        opened.value.clearQuarantineIfCurrent({
          ...key,
          quarantineId: current.quarantineId,
          quarantinedAt: current.quarantinedAt,
          consecutiveRetryableFailures:
            current.consecutiveRetryableFailures,
        }),
      ).toBe(true);
      expect(opened.value.quarantineFor(key)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid JSON returns a structured parse error", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-quarantine-store-"));
    try {
      const path = join(root, "quarantined.json");
      await writeFile(path, "{not-json", "utf8");

      const opened = openQuarantineStore({ path });

      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.kind).toBe("quarantine-store-parse-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid entry shape returns a boundary validation error", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-quarantine-store-"));
    try {
      const path = join(root, "quarantined.json");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          entries: [
            {
              phase: "garden",
              processorId: "test.processor",
              processorVersion: "0.0.1",
              triggerHash: "abc123",
              consecutiveRetryableFailures: -1,
            },
          ],
        }),
        "utf8",
      );

      const opened = openQuarantineStore({ path });

      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.kind).toBe("quarantine-store-parse-failed");
      expect(opened.error.cause).toContain(
        "entries.0.consecutiveRetryableFailures",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two stores on one file do not clobber each other (cross-process read-modify-write)", async () => {
    // Simulates `dome serve` and a concurrently-opened runtime (`dome
    // resolve` / `dome run`) holding independent store instances on the
    // same quarantined.json. Before the read-through fix, each instance
    // dumped its open-time snapshot on every mutation: B's write erased
    // A's quarantine, and A's stale map could resurrect a quarantine B
    // had cleared.
    const root = mkdtempSync(join(tmpdir(), "dome-quarantine-store-"));
    try {
      const path = join(root, ".dome", "state", "quarantined.json");
      const keyA: ProcessorExecutionKey = Object.freeze({
        phase: "garden",
        processorId: "test.processor-a",
        processorVersion: "0.0.1",
        triggerHash: "hash-a",
      });
      const keyB: ProcessorExecutionKey = Object.freeze({
        phase: "garden",
        processorId: "test.processor-b",
        processorVersion: "0.0.1",
        triggerHash: "hash-b",
      });

      // Both processes open before any state exists.
      const a = openQuarantineStore({ path, quarantineThreshold: 2 });
      const b = openQuarantineStore({ path, quarantineThreshold: 2 });
      if (!a.ok || !b.ok) throw new Error("open failed");

      // Process A quarantines keyA.
      a.value.recordRetryableTerminalFailure(keyA, "first");
      const quarantined = a.value.recordRetryableTerminalFailure(
        keyA,
        "second",
      );
      expect(quarantined).not.toBeNull();

      // Process B mutates a DIFFERENT key. With stale-snapshot dumping
      // this erased A's quarantine from the file.
      b.value.recordRetryableTerminalFailure(keyB, "unrelated");
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(
        persisted.entries.map(
          (e: { processorId: string }) => e.processorId,
        ),
      ).toContain("test.processor-a");

      // B sees A's quarantine through its own handle (read-through).
      expect(b.value.quarantineFor(keyA)).not.toBeNull();

      // B clears A's quarantine (the answer-handler path); A must observe
      // the clear instead of resurrecting it on its next write.
      b.value.clearQuarantine(keyA);
      expect(a.value.quarantineFor(keyA)).toBeNull();
      a.value.recordSuccess(keyB); // A mutates: must not resurrect keyA
      const after = JSON.parse(await readFile(path, "utf8"));
      expect(
        after.entries.map((e: { processorId: string }) => e.processorId),
      ).not.toContain("test.processor-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
