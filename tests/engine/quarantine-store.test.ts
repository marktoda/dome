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

      const body = JSON.parse(await readFile(path, "utf8"));
      expect(body.version).toBe(1);
      expect(body.entries[0].processorId).toBe("test.processor");
      expect(body.entries[0].quarantinedAt).toEqual(expect.any(String));

      const reopened = openQuarantineStore({
        path,
        quarantineThreshold: 2,
      });
      if (!reopened.ok) throw new Error(reopened.error.kind);
      expect(
        reopened.value.quarantineFor(key)?.consecutiveRetryableFailures,
      ).toBe(2);
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
});
