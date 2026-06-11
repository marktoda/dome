import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { viewEffect } from "../../src/core/effect";
import { defineProcessor } from "../../src/core/processor";
import { pageTypeDeclaration } from "../../src/page-types";
import { buildRegistry } from "../../src/processors/registry";
import { openVaultRuntime } from "../../src/engine/host/vault-runtime";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("openVaultRuntime bundle activation", () => {
  test("prebuilt registries respect .dome/config.yaml enabled bundle set", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-activation-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
engine:
  max_iterations: 9
git:
  auto_commit_workflows: false
extensions:
  enabled.bundle:
    enabled: true
    grant: {}
  disabled.bundle:
    enabled: false
    grant: {}
`,
      "utf8",
    );

    const enabled = defineProcessor({
      id: "enabled.bundle.view",
      version: "0.1.0",
      phase: "view",
      triggers: [{ kind: "command", name: "enabled" }],
      capabilities: [],
      run: async () => [
        viewEffect({
          name: "enabled",
          content: { kind: "structured", schema: "test", data: {} },
          scope: [],
        }),
      ],
    });
    const disabled = defineProcessor({
      id: "disabled.bundle.view",
      version: "0.1.0",
      phase: "view",
      triggers: [{ kind: "command", name: "disabled" }],
      capabilities: [],
      run: async () => [
        viewEffect({
          name: "disabled",
          content: { kind: "structured", schema: "test", data: {} },
          scope: [],
        }),
      ],
    });
    const registryResult = buildRegistry([enabled, disabled]);
    expect(registryResult.ok).toBe(true);
    if (!registryResult.ok) return;

    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      registry: registryResult.value,
      extensions: [
        { name: "enabled.bundle", version: "0.1.0" },
        { name: "disabled.bundle", version: "0.1.0" },
      ],
      processorVersions: [
        { id: "enabled.bundle.view", version: "0.1.0" },
        { id: "disabled.bundle.view", version: "0.1.0" },
      ],
      extensionPageTypes: new Map([
        [
          "enabled.bundle",
          [pageTypeDeclaration("enabled-type", "test:enabled.bundle")],
        ],
        [
          "disabled.bundle",
          [pageTypeDeclaration("disabled-type", "test:disabled.bundle")],
        ],
      ]),
    });

    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      expect(runtimeResult.value.registry.get("enabled.bundle.view")).toBeDefined();
      expect(runtimeResult.value.registry.get("disabled.bundle.view")).toBeUndefined();
      expect(runtimeResult.value.extensions).toEqual([
        { name: "enabled.bundle", version: "0.1.0" },
      ]);
      expect(runtimeResult.value.processorVersions).toEqual([
        { id: "enabled.bundle.view", version: "0.1.0" },
      ]);
      expect(runtimeResult.value.config).toEqual({
        engine: {
          maxIterations: 9,
          executionCap: {},
          autoResolveQuestions: {
            enabled: false,
            policies: ["agent-safe"],
            minConfidence: 0.6,
            maxPerTick: 20,
          },
        },
        git: { auto_commit_workflows: false },
      });
      expect(runtimeResult.value.pageTypes.types.has("enabled-type")).toBe(true);
      expect(runtimeResult.value.pageTypes.types.has("disabled-type")).toBe(false);
    } finally {
      await runtimeResult.value.close();
    }
  });
});

describe("openVaultRuntime maintenance-loop composition", () => {
  function writeLoopBundleFixture(bundlesRoot: string, loopId: string): void {
    const bundleDir = join(bundlesRoot, "acme.todo");
    mkdirSync(join(bundleDir, "processors"), { recursive: true });
    writeFileSync(
      join(bundleDir, "processors", "scan.ts"),
      "export default { async run() { return []; } };\n",
    );
    writeFileSync(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "acme.todo",
        version: "0.1.0",
        processors: [
          {
            id: "acme.todo.scan",
            version: "0.1.0",
            phase: "garden",
            triggers: [{ kind: "signal", name: "file.created" }],
            capabilities: [],
            module: "processors/scan.ts",
          },
        ],
        loops: [
          {
            id: loopId,
            goal: "Todos stay scanned.",
            evidence: [{ kind: "operational", name: "diagnostics" }],
            processors: ["acme.todo.scan"],
            surfaces: [{ kind: "status", name: "check" }],
            settlement: { key: "todo path", noOpWhen: "scanned" },
            risks: ["Scan noise."],
          },
        ],
      }),
    );
  }

  test("runtime loops = first-party registry + active bundle manifest loops", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-loops-"));
    roots.push(root);
    const bundlesRoot = join(root, "bundles");
    writeLoopBundleFixture(bundlesRoot, "acme.todo.coherence");

    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      bundlesRoot,
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      const ids = runtimeResult.value.maintenanceLoops.map((loop) => loop.id);
      expect(ids).toContain("acme.todo.coherence");
      expect(ids).toContain("dome.capture.digest"); // first-party composition
    } finally {
      await runtimeResult.value.close();
    }
  });

  test("a bundle loop colliding with a first-party loop id fails the open", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-loops-dup-"));
    roots.push(root);
    const bundlesRoot = join(root, "bundles");
    writeLoopBundleFixture(bundlesRoot, "dome.capture.digest");

    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      bundlesRoot,
    });
    expect(runtimeResult.ok).toBe(false);
    if (runtimeResult.ok) {
      await runtimeResult.value.close();
      return;
    }
    expect(runtimeResult.error.kind).toBe("maintenance-loop-conflict");
  });
});
