import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  defaultModelProviderConfig,
  defaultConfigRecord,
  defaultConfigYaml,
  FIRST_PARTY_EXTENSION_DEFAULTS,
} from "../../src/cli/default-vault-config";
import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import {
  DEFAULT_RUNTIME_CONFIG,
  loadCapabilityPolicy,
} from "../../src/engine/core/capability-policy";
import { graphWriteCovers } from "../../src/engine/core/capability-broker";
import { readablePath } from "../../src/engine/core/path-capabilities";
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

  test("source-subscription YAML round-trips to the typed defaults", () => {
    expect(
      parseYaml(defaultConfigYaml({ sources: ["calendar", "slack"] })),
    ).toEqual(defaultConfigRecord({ sources: ["calendar", "slack"] }));
    // `calendar` already ships in the dome.sources default — requesting it
    // is a no-op on the rendered config.
    expect(defaultConfigYaml({ sources: ["calendar"] })).toBe(
      defaultConfigYaml(),
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

  test("default config grants the deterministic brief/calendar indexers their fact namespaces", async () => {
    // Regression: the dome.agent bundle graph.write is scoped to
    // dome.preference.* (model-processors-emit-no-durable-facts), but the
    // DETERMINISTIC brief-index/calendar-index extractors publish
    // dome.agent.brief / dome.agent.calendar.event facts the cockpit reads.
    // Without per-processor grants the broker denies those facts and the
    // today view's brief/calendar render empty. Verify the SAME namespace
    // matcher the broker uses now covers them.
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-grant-"));
    try {
      await mkdir(join(root, ".dome"), { recursive: true });
      // dome.agent ships enabled by default (product-review-3 Task 17), so
      // its (deterministic indexer) per-processor grants are already loaded
      // by the capability policy from the unmodified default record.
      const rec = structuredClone(defaultConfigRecord()) as {
        extensions: Record<string, { enabled: boolean }>;
      };
      expect(rec.extensions["dome.agent"]!.enabled).toBe(true);
      await writeFile(join(root, ".dome", "config.yaml"), stringifyYaml(rec), "utf8");
      const policy = await loadCapabilityPolicy(root);
      expect(policy.ok).toBe(true);
      if (!policy.ok) throw new Error(policy.error);

      const briefGraphWrite = policy.value
        .grantsForProcessor("dome.agent", "dome.agent.brief-index")
        .filter((c) => c.kind === "graph.write");
      expect(graphWriteCovers("dome.agent.brief", briefGraphWrite)).toBe(true);

      const calendarGraphWrite = policy.value
        .grantsForProcessor("dome.agent", "dome.agent.calendar-index")
        .filter((c) => c.kind === "graph.write");
      expect(graphWriteCovers("dome.agent.calendar.event", calendarGraphWrite)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("default config feeds compose-blocks: declared ∩ granted covers its signal paths", async () => {
    // Regression: the dome.daily bundle read grant predated compose-blocks'
    // source reads. Grant-scoped snapshot misses are silent, so the agenda /
    // sources blocks would silently never render — the exact
    // silent-degradation mode the daily-surface design exists to eliminate.
    // Verify with the SAME declared-∩-granted matcher the runtime's
    // readableSignalsForProcessor / scoped snapshot use.
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-compose-"));
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

      const bundles = await loadBundles({
        bundlesRoot: resolveShippedBundlesRoot(),
        activeBundleIds: new Set(["dome.daily"]),
      });
      expect(bundles.ok).toBe(true);
      if (!bundles.ok) throw new Error(bundles.error.kind);
      const composeBlocks = bundles.value
        .flatMap((bundle) => bundle.processors)
        .find((processor) => processor.id === "dome.daily.compose-blocks");
      expect(composeBlocks).toBeDefined();
      if (composeBlocks === undefined) return;

      const granted = policy.value.grantsForProcessor(
        "dome.daily",
        "dome.daily.compose-blocks",
      );
      // Representative concrete paths for every signal trigger pathPattern
      // plus the daily itself.
      for (const path of [
        "sources/calendar/2026-01-02.md",
        "sources/slack/2026-01-02.md",
        "wiki/dailies/2026-01-02.md",
      ]) {
        expect(
          readablePath(path, composeBlocks.capabilities, granted),
          `${path} must be readable under declared ∩ granted`,
        ).not.toBeNull();
      }
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
      grants?: string;
      extensions: Record<
        string,
        { enabled: boolean; config?: Record<string, unknown>; grant?: Record<string, unknown> }
      >;
    };
    // Fresh vaults collapse grants to the one-line `grants: standard` preset —
    // no per-bundle grant blocks are rendered. The read/external grant that
    // used to sit here now comes from the loader's preset expansion (verified
    // by the round-trip test below).
    expect(rendered.grants).toBe("standard");
    const sources = rendered.extensions["dome.sources"];
    expect(sources).toBeDefined();
    expect(sources?.enabled).toBe(true);
    expect(sources?.grant).toBeUndefined();
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

  test("shipped template omits retired metadata-only question auto-resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-autoresolve-"));
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

      expect(defaultConfigYaml()).not.toContain("auto_resolve_questions");
      expect(policy.value.runtime.engine.autoResolveQuestions.enabled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(DEFAULT_RUNTIME_CONFIG.engine.autoResolveQuestions.enabled).toBe(false);
  });

  test("shipped template ships run-ledger retention on (30 days); engine built-in default stays forever", async () => {
    // Task 3: the vault template ships `ledger.retention_days: 30` so new
    // vaults auto-prune the run ledger out of the box (dome serve prunes
    // daily once the knob is set). The engine's own DEFAULT_RUNTIME_CONFIG
    // (used when a vault has no config at all) must stay retention-less
    // ("forever") — the template is what opts in, not the engine built-in.
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-ledger-"));
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

      expect(policy.value.runtime.ledger.retentionDays).toBe(30);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(DEFAULT_RUNTIME_CONFIG.ledger).toEqual({});
  });

  test("dome.agent ships enabled with the $2/day guardrail cap (Task 17: brain on by default)", async () => {
    // The old protection was a disabled bundle; the new protection is a
    // shipped daily cost cap. `dome.agent` must ship `enabled: true` so a
    // fresh `dome init` yields a working brief within 24h given an API key,
    // and the vault-wide `model.invoke` grant — the extension-wide pool,
    // distinct from the per-processor declared caps in manifest.yaml — must
    // be the new $2.00/day default.
    const rendered = parseYaml(defaultConfigYaml()) as {
      grants?: string;
      extensions: Record<
        string,
        {
          enabled: boolean;
          grant?: Record<string, unknown>;
        }
      >;
    };
    const agent = rendered.extensions["dome.agent"];
    expect(agent).toBeDefined();
    expect(agent?.enabled).toBe(true);
    // Grants collapse to the top-level preset; no per-bundle grant block is
    // rendered. The $2/day cap is verified through the loaded policy below,
    // where the preset expands it.
    expect(rendered.grants).toBe("standard");
    expect(agent?.grant).toBeUndefined();

    // Load-bearing round trip: the same cap is live once the capability
    // policy resolves the rendered config, and it is scoped to the vault
    // grant (the pooled cap) — not a substitute for the manifest's
    // per-processor declared caps, which stay unchanged.
    const root = mkdtempSync(join(tmpdir(), "dome-default-config-agent-cap-"));
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

      expect(policy.value.isExtensionEnabled("dome.agent")).toBe(true);
      const grantedModelInvoke = policy.value
        .grantsForExtension("dome.agent")
        .find((c) => c.kind === "model.invoke");
      expect(grantedModelInvoke).toEqual({
        kind: "model.invoke",
        maxDailyCostUsd: 2,
      });

      const bundles = await loadBundles({
        bundlesRoot: resolveShippedBundlesRoot(),
        activeBundleIds: new Set(policy.value.enabledExtensionIds),
      });
      expect(bundles.ok).toBe(true);
      if (!bundles.ok) throw new Error(bundles.error.kind);
      const ingest = bundles.value
        .find((b) => b.id === "dome.agent")
        ?.processors.find((p) => p.id === "dome.agent.ingest");
      expect(ingest).toBeDefined();
      // The per-processor declared cap (ingest's own $5/day promise) is
      // untouched — the $2/day pool is the tighter, binding constraint now,
      // not a replacement for the declared caps.
      const declaredModelInvoke = ingest?.capabilities.find(
        (c) => c.kind === "model.invoke",
      );
      expect(declaredModelInvoke).toEqual({
        kind: "model.invoke",
        maxDailyCostUsd: 5,
      });
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
