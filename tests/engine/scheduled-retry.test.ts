// Explicit scheduled-garden recovery through the compiler-host engine-control
// seam. The test reproduces the brief's real failure shape: the processor run
// succeeds while emitting a warning + deterministic fallback patch, so retry
// cannot be gated on a failed ledger row.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import { defineProcessor, type Processor } from "../../src/core/processor";
import { transientProcessorError } from "../../src/core/processor-error";
import { commitOid } from "../../src/core/source-ref";
import {
  retryScheduledProcessor,
  runCompilerHostTick,
} from "../../src/engine/host/compiler-host";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../src/engine/host/vault-runtime";
import { commit, currentSha, initRepo } from "../../src/git";
import { buildRegistry } from "../../src/processors/registry";
import { queryDiagnostics } from "../../src/projections/diagnostics";
import { getCursor } from "../../src/projections/schedule-cursors";

const PROCESSOR_ID = "test.agent.brief";
const NOW = new Date("2026-07-16T09:30:00.000Z");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

async function makeVault(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "dome-scheduled-retry-"));
  roots.push(root);
  await initRepo(root);
  await mkdir(join(root, "wiki"), { recursive: true });
  await writeFile(join(root, "wiki/seed.md"), "# Seed\n");
  await commit({ path: root, message: "init\n", files: ["wiki/seed.md"] });
  await mkdir(join(root, ".dome", "state"), { recursive: true });
  return root;
}

async function openRuntime(
  vaultPath: string,
  run: Parameters<typeof defineProcessor>[0]["run"],
  extras: ReadonlyArray<Processor<unknown>> = [],
): Promise<VaultRuntime> {
  const processor = defineProcessor({
    id: PROCESSOR_ID,
    version: "0.1.0",
    phase: "garden",
    triggers: [{ kind: "schedule", cron: "30 5 * * *" }],
    capabilities: [
      { kind: "read", paths: ["wiki/**"] },
      { kind: "patch.auto", paths: ["wiki/**"] },
    ],
    run,
  });
  const processors = [processor, ...extras];
  const registry = buildRegistry(processors);
  if (!registry.ok) throw new Error(`registry failed: ${registry.error.kind}`);
  const opened = await openVaultRuntime({
    vaultPath,
    registry: registry.value,
    extensions: [{ name: "test.agent", version: "0.1.0" }],
    processorVersions: processors.map((loaded) => ({
      id: loaded.id,
      version: loaded.version,
    })),
  });
  if (!opened.ok) throw new Error(`runtime failed: ${opened.error.kind}`);
  return opened.value;
}

describe("retryScheduledProcessor", () => {
  test("replaces a handled failure, resolves its finding, adopts the patch, and leaves the live cursor byte-identical", async () => {
    const vaultPath = await makeVault();
    let providerReady = false;
    let attempts = 0;
    const runtime = await openRuntime(vaultPath, async (ctx) => {
      attempts += 1;
      const ref = ctx.sourceRef("wiki/brief.md");
      if (!providerReady) {
        return [
          diagnosticEffect({
            severity: "warning",
            code: "test.agent.brief-failed",
            message: "provider unavailable",
            sourceRefs: [ref],
          }),
          patchEffect({
            mode: "auto",
            changes: [{
              kind: "write",
              path: "wiki/brief.md",
              content: "Fallback. Retry: `dome retry test.agent.brief`.\n",
            }],
            reason: "deterministic brief fallback",
            sourceRefs: [ref],
          }),
        ];
      }
      return [patchEffect({
        mode: "auto",
        changes: [{
          kind: "write",
          path: "wiki/brief.md",
          content: "Recovered brief.\n",
        }],
        reason: "recovered brief",
        sourceRefs: [ref],
      })];
    });

    try {
      // First compiler tick initializes the adopted ref and fires a new
      // scheduled processor. Its handled provider failure is still a
      // succeeded ledger execution, exactly like dome.agent.brief.
      const first = await runCompilerHostTick({ runtime, now: () => NOW });
      expect(first.kind).toBe("adopted");
      expect(attempts).toBe(1);
      expect(await readFile(join(vaultPath, "wiki/brief.md"), "utf8"))
        .toContain("dome retry test.agent.brief");
      expect(queryDiagnostics(runtime.projectionDb, { processorId: PROCESSOR_ID })
        .map((diagnostic) => diagnostic.code))
        .toContain("test.agent.brief-failed");

      const cursorBefore = getCursor(runtime.projectionDb, PROCESSOR_ID);
      expect(cursorBefore).not.toBeNull();
      providerReady = true;
      const retried = await retryScheduledProcessor({
        runtime,
        processorId: PROCESSOR_ID,
        now: () => new Date("2026-07-16T10:00:00.000Z"),
      });

      expect(retried.kind).toBe("completed");
      if (retried.kind !== "completed") return;
      expect(retried.executionStatus).toBe("succeeded");
      expect(retried.subProposals).toEqual({ attempted: 1, adopted: 1, blocked: 0 });
      expect(await readFile(join(vaultPath, "wiki/brief.md"), "utf8"))
        .toBe("Recovered brief.\n");
      expect(queryDiagnostics(runtime.projectionDb, { processorId: PROCESSOR_ID })
        .map((diagnostic) => diagnostic.code))
        .not.toContain("test.agent.brief-failed");
      expect(getCursor(runtime.projectionDb, PROCESSOR_ID)).toEqual(cursorBefore);
      expect(attempts).toBe(2);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("refuses pending drift before invoking the processor", async () => {
    const vaultPath = await makeVault();
    let attempts = 0;
    const runtime = await openRuntime(vaultPath, async () => {
      attempts += 1;
      return [];
    });
    try {
      await runCompilerHostTick({ runtime, now: () => NOW });
      expect(attempts).toBe(1);
      await writeFile(join(vaultPath, "wiki/drift.md"), "# Drift\n");
      await commit({ path: vaultPath, message: "pending\n", files: ["wiki/drift.md"] });

      const result = await retryScheduledProcessor({
        runtime,
        processorId: PROCESSOR_ID,
      });
      expect(result.kind).toBe("sync-needed");
      expect(attempts).toBe(1);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("reports a blocked garden sub-Proposal as recovery failure evidence", async () => {
    const vaultPath = await makeVault();
    let shouldPatch = false;
    const blocker = defineProcessor({
      id: "test.adoption.blocker",
      version: "0.1.0",
      phase: "adoption",
      triggers: [{ kind: "path", pattern: "wiki/blocked.md" }],
      capabilities: [{ kind: "read", paths: ["wiki/**"] }],
      run: async (ctx) => [diagnosticEffect({
        severity: "block",
        code: "test.blocked",
        message: "blocked for test",
        sourceRefs: [ctx.sourceRef("wiki/blocked.md")],
      })],
    });
    const runtime = await openRuntime(vaultPath, async (ctx) => {
      if (shouldPatch) {
        return [patchEffect({
            mode: "auto",
            changes: [{ kind: "write", path: "wiki/blocked.md", content: "blocked\n" }],
            reason: "exercise blocked recovery",
            sourceRefs: [ctx.sourceRef("wiki/blocked.md")],
          })];
      }
      return [diagnosticEffect({
        severity: "warning",
        code: "test.agent.brief-failed",
        message: "prior failure must survive a blocked recovery",
        sourceRefs: [ctx.sourceRef("wiki/blocked.md")],
      })];
    }, [blocker]);
    try {
      await runCompilerHostTick({ runtime, now: () => NOW });
      expect(queryDiagnostics(runtime.projectionDb, { processorId: PROCESSOR_ID })
        .map((diagnostic) => diagnostic.code))
        .toContain("test.agent.brief-failed");
      shouldPatch = true;
      const cursorBefore = getCursor(runtime.projectionDb, PROCESSOR_ID);
      const result = await retryScheduledProcessor({
        runtime,
        processorId: PROCESSOR_ID,
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.routing.spawnedPatchCount).toBe(1);
      expect(result.subProposals).toEqual({ attempted: 1, adopted: 0, blocked: 1 });
      expect(getCursor(runtime.projectionDb, PROCESSOR_ID)).toEqual(cursorBefore);
      expect(queryDiagnostics(runtime.projectionDb, { processorId: PROCESSOR_ID })
        .map((diagnostic) => diagnostic.code))
        .toContain("test.agent.brief-failed");
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("restores the exact live schedule cursor when stale projection state is rebuilt", async () => {
    const vaultPath = await makeVault();
    const runtime = await openRuntime(vaultPath, async () => []);
    try {
      await runCompilerHostTick({ runtime, now: () => NOW });
      const cursorBefore = getCursor(runtime.projectionDb, PROCESSOR_ID);
      expect(cursorBefore).not.toBeNull();
      runtime.projectionDb.raw
        .query("UPDATE projection_meta SET adopted_commit = NULL")
        .run();

      const result = await retryScheduledProcessor({
        runtime,
        processorId: PROCESSOR_ID,
        now: () => new Date("2026-07-16T10:45:00.000Z"),
      });

      expect(result.kind).toBe("completed");
      expect(getCursor(runtime.projectionDb, PROCESSOR_ID)).toEqual(cursorBefore);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("relocks once then refuses a second checkout race without dispatch", async () => {
    const vaultPath = await makeVault();
    let attempts = 0;
    const runtime = await openRuntime(vaultPath, async () => {
      attempts += 1;
      return [];
    });
    try {
      await runCompilerHostTick({ runtime, now: () => NOW });
      expect(attempts).toBe(1);
      const head = commitOid((await currentSha(vaultPath))!);
      let observations = 0;
      const result = await retryScheduledProcessor(
        { runtime, processorId: PROCESSOR_ID },
        {
          getBranch: async () => "branch-one",
          detect: async () => {
            observations += 1;
            return {
              kind: "in-sync" as const,
              branch: observations === 1 ? "branch-two" : "branch-three",
              head,
            };
          },
        },
      );
      expect(result).toEqual({ kind: "branch-changed", branch: "branch-three" });
      expect(observations).toBe(2);
      expect(attempts).toBe(1);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test("uses the ordinary quarantine state instead of bypassing it", async () => {
    const vaultPath = await makeVault();
    let attempts = 0;
    const runtime = await openRuntime(vaultPath, async () => {
      attempts += 1;
      throw transientProcessorError("provider temporarily unavailable");
    });
    try {
      // The scheduled tick is retryable failure one; two explicit retries
      // trip the standard threshold. A third explicit retry must be skipped.
      await runCompilerHostTick({ runtime, now: () => NOW });
      await retryScheduledProcessor({ runtime, processorId: PROCESSOR_ID });
      await retryScheduledProcessor({ runtime, processorId: PROCESSOR_ID });
      const quarantined = await retryScheduledProcessor({
        runtime,
        processorId: PROCESSOR_ID,
      });

      expect(attempts).toBe(3);
      expect(quarantined.kind).toBe("completed");
      if (quarantined.kind !== "completed") return;
      expect(quarantined.executionStatus).toBe("skipped");
      expect(quarantined.executionError?.code).toBe("processor.quarantined");
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
