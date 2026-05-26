// AC2: drop a file into inbox/raw/, run `dome reconcile`, observe that the
// file is detected and `document.written.inbox.raw` is emitted.
//
// Note: a full inbox-empties-into-wiki run requires the ingest LLM workflow.
// reconcile()'s job (phase 1) is to detect inbox files and fire events for
// any registered intake hooks; the move itself is performed by the workflow
// in a later pass. v0.5.1 wires the full ingest-into-move path.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { reconcile } from "../../src/reconcile";
import type { HookEvent } from "../../src/hook-context";

describe("reconcile end-to-end: drop -> reconcile detects -> event fires", () => {
  test("reconcile emits document.written.inbox.raw for a file dropped into inbox/raw/", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-reconcile-e2e-"));
    const vaultPath = join(base, "vault");
    try {
      // 1. Bootstrap a vault.
      const initRes = await domeInit(vaultPath);
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      // 2. Drop a raw file directly into inbox/raw/. This simulates a user or
      //    external intake script (an MCP harness, voice ingester, etc.)
      //    dropping a capture without going through the Tool surface.
      const droppedPath = join(vaultPath, "inbox", "raw", "2026-05-25T12-00-00.md");
      await writeFile(
        droppedPath,
        "# Random capture\n\nObservation about [[wiki/entities/atlas]].\n",
      );
      expect(existsSync(droppedPath)).toBe(true);

      // 3. Open + reconcile, capturing every event.
      const openRes = await openVault(vaultPath);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;

      const events: HookEvent[] = [];
      const res = await reconcile(openRes.value, {
        onEvent: (e) => {
          events.push(e);
        },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // 4. AC: inbox-raw event was emitted.
      const inboxRawEvents = events.filter(
        (e) => e.kind === "document.written.inbox.raw",
      );
      expect(inboxRawEvents.length).toBeGreaterThanOrEqual(1);
      // The event carries the path of the file we dropped.
      const evt = inboxRawEvents[0]!;
      expect((evt as { path: string }).path).toBe("inbox/raw/2026-05-25T12-00-00.md");

      // 5. AC: file is still present. Reconcile-without-workflow does not move
      //    inbox files — that's the ingest workflow's job. The intake hook
      //    fires (we just observed the event); a future ingest run consumes it.
      expect(existsSync(droppedPath)).toBe(true);

      // Sanity: reconcile reports inboxProcessed >= 1.
      expect(res.value.inboxProcessed).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
