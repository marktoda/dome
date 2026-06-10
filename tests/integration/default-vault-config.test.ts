import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  defaultModelProviderConfig,
  defaultConfigRecord,
  defaultConfigYaml,
  FIRST_PARTY_EXTENSION_DEFAULTS,
} from "../../src/cli/default-vault-config";
import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import { loadCapabilityPolicy } from "../../src/engine/core/capability-policy";
import { loadBundles } from "../../src/extensions/loader";

describe("default vault config", () => {
  test("rendered YAML round-trips to the typed default record", () => {
    expect(parseYaml(defaultConfigYaml())).toEqual(defaultConfigRecord());
  });

  test("model-provider YAML round-trips to the typed provider default", () => {
    expect(parseYaml(defaultConfigYaml({ modelProvider: "anthropic" }))).toEqual(
      defaultConfigRecord({ modelProvider: "anthropic" }),
    );
    const parsed = parseYaml(
      defaultConfigYaml({ modelProvider: "anthropic" }),
    ) as Record<string, unknown>;
    expect(parsed.model_provider).toEqual(
      defaultModelProviderConfig("anthropic"),
    );
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

  test("first-party defaults do not grant undeclared capability kinds", async () => {
    const loaded = await loadBundles({ bundlesRoot: resolveShippedBundlesRoot() });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.kind);

    const bundlesById = new Map(
      loaded.value.map((bundle) => [bundle.id, bundle]),
    );
    const extras: string[] = [];
    for (const entry of FIRST_PARTY_EXTENSION_DEFAULTS) {
      const bundle = bundlesById.get(entry.id);
      expect(bundle, `${entry.id} default has no shipped bundle`).toBeDefined();
      if (bundle === undefined) continue;
      const declaredKinds: Set<string> = new Set(
        bundle.processors.flatMap((processor) =>
          processor.capabilities.map((capability) => capability.kind)
        ),
      );
      for (const key of Object.keys(entry.grant)) {
        if (!declaredKinds.has(key)) extras.push(`${entry.id}:${key}`);
      }
    }

    expect(extras).toEqual([]);
  });

  test("dome.sources ships the calendar subscription visible but OFF (the consent surface)", () => {
    // The shipped default makes opting in a one-line flip (enabled: true +
    // a vault-authored fetch command) and makes silence the default:
    // enabled must be EXACTLY false as shipped (wiki/specs/sources.md).
    const rendered = parseYaml(defaultConfigYaml()) as {
      extensions: Record<
        string,
        { enabled: boolean; config?: Record<string, unknown>; grant: Record<string, unknown> }
      >;
    };
    const sources = rendered.extensions["dome.sources"];
    expect(sources).toBeDefined();
    expect(sources?.enabled).toBe(true);
    expect(sources?.config).toEqual({
      subscriptions: {
        calendar: {
          enabled: false,
          schedule: "10 5 * * *",
          output_path: "sources/calendar/{date}.md",
          command: ["sh", ".dome/bin/fetch-calendar.sh"],
        },
      },
    });
    expect(sources?.grant).toEqual({
      read: ["sources/**/*.md", ".dome/config.yaml"],
      external: ["sources.fetch"],
    });
  });

  test("the shipped default config parses with the per-extension config block intact", async () => {
    // YAML render → loadCapabilityPolicy round trip: the `config:` block must
    // survive parsing and reach `configForExtension` (the fetch processor's
    // ctx.extensionConfig), not just the grant keys.
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-sources-"));
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
      const config = policy.value.configForExtension("dome.sources") as {
        subscriptions?: Record<string, { enabled?: unknown }>;
      };
      expect(config.subscriptions?.calendar?.enabled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("broad first-party default path grants stay explicit", () => {
    expect(broadDefaultPathGrants()).toEqual([
      "dome.graph:read:**/*.md",
      "dome.health:read:**",
      "dome.lint:read:**/*.md",
      "dome.markdown:patch.auto:**/*.md",
      "dome.markdown:read:**/*.md",
      "dome.markdown:read:**/*.{png,jpg,jpeg,gif,webp,svg,avif}",
      "dome.markdown:read:raw/**",
      "dome.search:read:**/*.md",
      "dome.search:search.write:**/*.md",
    ]);
  });

  test("typed default extensions match shipped first-party bundle directories", async () => {
    const loaded = await loadBundles({ bundlesRoot: resolveShippedBundlesRoot() });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.kind);

    expect(FIRST_PARTY_EXTENSION_DEFAULTS.map((entry) => entry.id).sort())
      .toEqual(loaded.value.map((bundle) => bundle.id).sort());
  });
});

function broadDefaultPathGrants(): ReadonlyArray<string> {
  const pathGrantKeys = new Set([
    "read",
    "patch.auto",
    "patch.propose",
    "search.write",
  ]);
  const grants: string[] = [];
  for (const entry of FIRST_PARTY_EXTENSION_DEFAULTS) {
    for (const [capability, value] of Object.entries(entry.grant)) {
      if (!pathGrantKeys.has(capability) || !Array.isArray(value)) continue;
      for (const pattern of value) {
        if (isBroadDefaultPathPattern(pattern)) {
          grants.push(`${entry.id}:${capability}:${pattern}`);
        }
      }
    }
  }
  return Object.freeze(grants.sort());
}

function isBroadDefaultPathPattern(pattern: string): boolean {
  return pattern === "**" || pattern.startsWith("**/") || pattern === "raw/**";
}
