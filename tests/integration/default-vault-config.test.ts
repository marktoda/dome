import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  defaultConfigRecord,
  defaultConfigYaml,
  FIRST_PARTY_EXTENSION_DEFAULTS,
} from "../../src/cli/default-vault-config";
import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import { loadCapabilityPolicy } from "../../src/engine/capability-policy";
import { loadBundles } from "../../src/extensions/loader";

describe("default vault config", () => {
  test("rendered YAML round-trips to the typed default record", () => {
    expect(parseYaml(defaultConfigYaml())).toEqual(defaultConfigRecord());
  });

  test("enabled first-party defaults grant every declared capability kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-"));
    try {
      await mkdir(join(root, ".dome"), { recursive: true });
      await writeFile(
        join(root, ".dome", "config.yaml"),
        defaultConfigYaml(),
        "utf8",
      );

      const policy = await loadCapabilityPolicy(root);
      expect(policy.ok).toBe(true);
      if (!policy.ok) throw new Error(policy.error);

      const active = new Set(policy.value.enabledExtensionIds);
      const bundles = await loadBundles({
        bundlesRoot: resolveShippedBundlesRoot(),
        activeBundleIds: active,
      });
      expect(bundles.ok).toBe(true);
      if (!bundles.ok) throw new Error(bundles.error.kind);

      const missing: string[] = [];
      for (const bundle of bundles.value) {
        for (const processor of bundle.processors) {
          const grantedKinds = new Set(
            policy.value
              .grantsForProcessor(bundle.id, processor.id)
              .map((capability) => capability.kind),
          );
          for (const capability of processor.capabilities) {
            if (!grantedKinds.has(capability.kind)) {
              missing.push(`${processor.id}:${capability.kind}`);
            }
          }
        }
      }
      expect(missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("typed default extensions match shipped first-party bundle directories", async () => {
    const loaded = await loadBundles({ bundlesRoot: resolveShippedBundlesRoot() });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.kind);

    expect(FIRST_PARTY_EXTENSION_DEFAULTS.map((entry) => entry.id).sort())
      .toEqual(loaded.value.map((bundle) => bundle.id).sort());
  });
});
