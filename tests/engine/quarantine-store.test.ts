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
});
