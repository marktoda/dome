import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { viewEffect } from "../../src/core/effect";
import { defineProcessor } from "../../src/core/processor";
import { buildRegistry } from "../../src/processors/registry";
import { openVaultRuntime } from "../../src/engine/vault-runtime";

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
    } finally {
      await runtimeResult.value.close();
    }
  });
});
