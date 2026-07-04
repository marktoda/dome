import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { viewEffect } from "../../src/core/effect";
import { defineProcessor } from "../../src/core/processor";
import { pageTypeDeclaration } from "../../src/page-types";
import { buildRegistry } from "../../src/processors/registry";
import {
  AGENT_NO_MODEL_PROVIDER_MESSAGE,
  openVaultRuntime,
} from "../../src/engine/host/vault-runtime";
import type { ModelProvider } from "../../src/engine/core/model-invoke";

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
        ledger: {},
      });
      expect(runtimeResult.value.pageTypes.types.has("enabled-type")).toBe(true);
      expect(runtimeResult.value.pageTypes.types.has("disabled-type")).toBe(false);
    } finally {
      await runtimeResult.value.close();
    }
  });
});

describe("openVaultRuntime registry-orphan GC", () => {
  test("prunes a retired-bundle counter on open, keeps enabled + disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-gc-"));
    roots.push(root);
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
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
    // Seed quarantined.json directly with three counters: enabled (registered),
    // disabled (configured-but-off), retired (neither, and ACTUALLY
    // quarantined — the case the health emitter would otherwise re-ask
    // about forever). Only the retired one should be GC'd on open.
    writeFileSync(
      join(root, ".dome", "state", "quarantined.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            phase: "garden",
            processorId: "enabled.bundle.worker",
            processorVersion: "0.1.0",
            triggerHash: "h-enabled",
            consecutiveRetryableFailures: 2,
          },
          {
            phase: "garden",
            processorId: "disabled.bundle.worker",
            processorVersion: "0.1.0",
            triggerHash: "h-disabled",
            consecutiveRetryableFailures: 2,
          },
          {
            phase: "garden",
            processorId: "retired.bundle.worker",
            processorVersion: "0.1.0",
            triggerHash: "h-retired",
            consecutiveRetryableFailures: 3,
            quarantineId: "q-retired-1",
            quarantinedAt: "2026-06-18T00:00:00.000Z",
            reason: "timeout",
          },
        ],
      }),
      "utf8",
    );

    const enabled = defineProcessor({
      id: "enabled.bundle.worker",
      version: "0.1.0",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [],
    });
    const disabled = defineProcessor({
      id: "disabled.bundle.worker",
      version: "0.1.0",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [],
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
        { id: "enabled.bundle.worker", version: "0.1.0" },
        { id: "disabled.bundle.worker", version: "0.1.0" },
      ],
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      // Read the persisted file back: the retired counter is gone, the
      // enabled and the registered-but-disabled counters survive.
      const after = JSON.parse(
        readFileSync(join(root, ".dome", "state", "quarantined.json"), "utf8"),
      ) as { entries: ReadonlyArray<{ processorId: string }> };
      const ids = after.entries.map((e) => e.processorId).sort();
      expect(ids).toEqual([
        "disabled.bundle.worker",
        "enabled.bundle.worker",
      ]);
      // The runtime reports exactly which processor ids it pruned — this is
      // the field a host-startup CLI surface (`dome serve`) reads to log the
      // GC loudly (src/cli/commands/serve.ts).
      expect(runtimeResult.value.prunedUnknownProcessorQuarantines).toEqual([
        "retired.bundle.worker",
      ]);
    } finally {
      await runtimeResult.value.close();
    }
  });

  test("does NOT prune when config was not found — a misread config can't nuke recovery state", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-gc-noconfig-"));
    roots.push(root);
    mkdirSync(join(root, ".dome", "state"), { recursive: true });
    // No .dome/config.yaml: policy.foundConfig is false. The prune guard
    // (foundConfig && (configuredExtensions || registry.size)) must short-
    // circuit so a read edge / missing config never discards live recovery
    // counters — including a counter for a processor that isn't in the
    // supplied registry at all (which would otherwise look "unknown").
    writeFileSync(
      join(root, ".dome", "state", "quarantined.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            phase: "garden",
            processorId: "retired.bundle.worker",
            processorVersion: "0.1.0",
            triggerHash: "h-retired",
            consecutiveRetryableFailures: 2,
          },
        ],
      }),
      "utf8",
    );

    const live = defineProcessor({
      id: "enabled.bundle.worker",
      version: "0.1.0",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [],
    });
    const registryResult = buildRegistry([live]);
    expect(registryResult.ok).toBe(true);
    if (!registryResult.ok) return;

    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      registry: registryResult.value,
      extensions: [{ name: "enabled.bundle", version: "0.1.0" }],
      processorVersions: [{ id: "enabled.bundle.worker", version: "0.1.0" }],
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      // The retired counter survives untouched: prune was never invoked.
      const after = JSON.parse(
        readFileSync(join(root, ".dome", "state", "quarantined.json"), "utf8"),
      ) as { entries: ReadonlyArray<{ processorId: string }> };
      const ids = after.entries.map((e) => e.processorId).sort();
      expect(ids).toEqual(["retired.bundle.worker"]);
      // Nothing to report either — the prune guard short-circuited.
      expect(runtimeResult.value.prunedUnknownProcessorQuarantines).toEqual(
        [],
      );
    } finally {
      await runtimeResult.value.close();
    }
  });
});

describe("openVaultRuntime agentNoModelProviderWarning", () => {
  function agentBundleConfig(enabled: boolean): string {
    return `
extensions:
  dome.agent:
    enabled: ${enabled}
    grant: {}
`;
  }

  test("dome.agent enabled, no model provider wired -> loud warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-agent-warn-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(join(root, ".dome", "config.yaml"), agentBundleConfig(true), "utf8");

    const registryResult = buildRegistry([]);
    expect(registryResult.ok).toBe(true);
    if (!registryResult.ok) return;

    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      registry: registryResult.value,
      extensions: [],
      processorVersions: [],
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      expect(runtimeResult.value.agentNoModelProviderWarning).toEqual({
        code: "agent.no-model-provider",
        message: AGENT_NO_MODEL_PROVIDER_MESSAGE,
      });
    } finally {
      await runtimeResult.value.close();
    }
  });

  test("dome.agent enabled with a model provider wired -> no warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-agent-warn-provided-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(join(root, ".dome", "config.yaml"), agentBundleConfig(true), "utf8");

    const registryResult = buildRegistry([]);
    expect(registryResult.ok).toBe(true);
    if (!registryResult.ok) return;

    const stubProvider: ModelProvider = async () => ({ text: "stub" });
    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      registry: registryResult.value,
      extensions: [],
      processorVersions: [],
      modelProvider: stubProvider,
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      expect(runtimeResult.value.agentNoModelProviderWarning).toBeNull();
    } finally {
      await runtimeResult.value.close();
    }
  });

  test("dome.agent disabled, no model provider wired -> no warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-runtime-agent-warn-disabled-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(join(root, ".dome", "config.yaml"), agentBundleConfig(false), "utf8");

    const registryResult = buildRegistry([]);
    expect(registryResult.ok).toBe(true);
    if (!registryResult.ok) return;

    const runtimeResult = await openVaultRuntime({
      vaultPath: root,
      registry: registryResult.value,
      extensions: [],
      processorVersions: [],
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      expect(runtimeResult.value.agentNoModelProviderWarning).toBeNull();
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
