import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import { defineProcessor, treeOid, type Processor } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/apply-effect";
import { runScheduler } from "../../src/engine/scheduler";
import type { EngineVault } from "../../src/engine/vault-shape";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { buildRegistry } from "../../src/processors/registry";

const ADOPTED = commitOid("adopted0000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");
const NOW = new Date("2026-05-28T12:00:00.000Z");

type Fixture = {
  readonly root: string;
  readonly projection: ProjectionDb;
  readonly vault: EngineVault;
};

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    try {
      fixture.projection.close();
    } catch {
      // already closed
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("runScheduler — executor-result telemetry", () => {
  test("processor execution failure diagnostic marks scheduled fire unsuccessful", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.thrower",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => {
        throw new Error("scheduled boom");
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const result = await runWithProcessor(fixture, processor);

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.thrower");
    expect(result.fired[0]?.success).toBe(false);
  });

  test("processor timeout diagnostic marks scheduled fire unsuccessful and discards late output", async () => {
    const lateEffect = diagnosticEffect({
      severity: "info",
      code: "test.scheduler.late",
      message: "late output should not make the fire successful",
      sourceRefs: [],
    });
    const processor = defineProcessor({
      id: "test.scheduler.timeout",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      execution: { class: "background", timeoutMs: 5 },
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return [lateEffect];
      },
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recordedDiagnostics: string[] = [];

    const result = await runWithProcessor(fixture, processor, {
      recordDiagnostic: async ({ effect }) => {
        recordedDiagnostics.push(effect.code);
      },
    });

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.timeout");
    expect(result.fired[0]?.success).toBe(false);
    expect(recordedDiagnostics).toContain("processor.timeout");
    expect(recordedDiagnostics).not.toContain("test.scheduler.late");
  });

  test("processor-emitted executor-like diagnostic code does not mark scheduled fire unsuccessful", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.user-diagnostic",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [
        diagnosticEffect({
          severity: "error",
          code: "processor.timeout",
          message: "user-space diagnostic with executor-like code",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const recordedDiagnostics: string[] = [];

    const result = await runWithProcessor(fixture, processor, {
      recordDiagnostic: async ({ effect }) => {
        recordedDiagnostics.push(effect.code);
      },
    });

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.user-diagnostic");
    expect(result.fired[0]?.success).toBe(true);
    expect(recordedDiagnostics).toContain("processor.timeout");
  });

  test("broker diagnostics do not mark scheduled fire unsuccessful", async () => {
    const processor = defineProcessor({
      id: "test.scheduler.capability-denied",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [
            { kind: "write", path: "wiki/scheduled.md", content: "scheduled\n" },
          ],
          reason: "missing grant",
          sourceRefs: [],
        }),
      ],
    });
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const result = await runWithProcessor(fixture, processor);

    expect(result.fired.length).toBe(1);
    expect(result.fired[0]?.processorId).toBe("test.scheduler.capability-denied");
    expect(result.fired[0]?.success).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "capability-deny-patch"))
      .toBe(true);
  });
});

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dome-scheduler-"));
  const projectionResult = await openProjectionDb({
    path: join(root, ".dome", "state", "projection.db"),
    extensionSet: [],
    processorVersions: [],
  });
  if (!projectionResult.ok) {
    throw new Error(
      `openProjectionDb failed: ${JSON.stringify(projectionResult.error)}`,
    );
  }
  return {
    root,
    projection: projectionResult.value.db,
    vault: {
      path: root,
      config: { git: { auto_commit_workflows: false } },
    },
  };
}

async function runWithProcessor(
  fixture: Fixture,
  processor: Processor,
  sinkOverrides: Partial<ReturnType<typeof noopSinks>> = {},
) {
  const registryResult = buildRegistry([processor]);
  if (!registryResult.ok) {
    throw new Error(`registry build failed: ${registryResult.error.kind}`);
  }
  return runScheduler({
    vault: fixture.vault,
    adopted: ADOPTED,
    registry: registryResult.value,
    projection: fixture.projection,
    sinks: { ...noopSinks(), ...sinkOverrides },
    resolveTree: async () => TREE,
    now: () => NOW,
    resolveGrants: () => [],
    extensionIdFor: (id) => id,
  });
}
