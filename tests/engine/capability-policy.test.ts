import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeCapabilityPolicyHash,
  loadCapabilityPolicy,
} from "../../src/engine/core/capability-policy";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("loadCapabilityPolicy", () => {
  test("missing config returns an empty not-found policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.foundConfig).toBe(false);
    expect(result.value.isExtensionEnabled("dome.markdown")).toBe(true);
    expect(result.value.grantsForExtension("dome.markdown")).toEqual([]);
    expect(
      result.value.grantsForProcessor(
        "dome.markdown",
        "dome.markdown.validate-wikilinks",
      ),
    ).toEqual([]);
  });

  test("parses extension grant blocks from .dome/config.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["**/*.md"]
      patch.auto: ["wiki/**"]
      graph.write: ["dome.graph.*"]
      question.ask: true
      external: ["calendar.write"]
      outbox.read: ["failed"]
      outbox.recover: true
      quarantine.read: true
      quarantine.recover: true
      run.read: ["running"]
      run.recover: true
  disabled.bundle:
    enabled: false
    grant:
      patch.auto: ["**"]
  omitted-enabled.bundle:
    grant:
      patch.auto: ["**"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grants = result.value.grantsForExtension("dome.markdown");
    expect(grants).toContainEqual({ kind: "read", paths: ["**/*.md"] });
    expect(grants).toContainEqual({ kind: "patch.auto", paths: ["wiki/**"] });
    expect(grants).toContainEqual({
      kind: "graph.write",
      namespaces: ["dome.graph.*"],
    });
    expect(grants).toContainEqual({ kind: "question.ask" });
    expect(grants).toContainEqual({
      kind: "external",
      capability: "calendar.write",
    });
    expect(grants).toContainEqual({
      kind: "outbox.read",
      statuses: ["failed"],
    });
    expect(grants).toContainEqual({
      kind: "outbox.recover",
      actions: ["retry", "abandon"],
    });
    expect(grants).toContainEqual({ kind: "quarantine.read" });
    expect(grants).toContainEqual({
      kind: "quarantine.recover",
      actions: ["reset"],
    });
    expect(grants).toContainEqual({
      kind: "run.read",
      statuses: ["running"],
    });
    expect(grants).toContainEqual({
      kind: "run.recover",
      actions: ["fail"],
    });
    expect(result.value.grantsForExtension("disabled.bundle")).toEqual([]);
    expect(result.value.grantsForExtension("omitted-enabled.bundle")).toEqual([]);
    expect(result.value.grantsForExtension("missing.bundle")).toEqual([]);
    expect(result.value.enabledExtensionIds).toEqual(["dome.markdown"]);
    expect(result.value.isExtensionEnabled("dome.markdown")).toBe(true);
    expect(result.value.isExtensionEnabled("disabled.bundle")).toBe(false);
    expect(result.value.isExtensionEnabled("omitted-enabled.bundle")).toBe(false);
    expect(result.value.isExtensionEnabled("missing.bundle")).toBe(false);
  });

  test("parses processor grant overrides as replacement grants", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      patch.auto: ["wiki/**/*.md"]
      question.ask: true
    processors:
      dome.markdown.validate-wikilinks:
        grant:
          read: ["**/*.md"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processorGrantIdsForExtension("dome.markdown")).toEqual([
      "dome.markdown.validate-wikilinks",
    ]);
    expect(
      result.value.grantsForProcessor(
        "dome.markdown",
        "dome.markdown.validate-wikilinks",
      ),
    ).toEqual([{ kind: "read", paths: ["**/*.md"] }]);
    expect(
      result.value.grantsForProcessor(
        "dome.markdown",
        "dome.markdown.normalize-frontmatter",
      ),
    ).toEqual([
      { kind: "read", paths: ["wiki/**/*.md"] },
      { kind: "patch.auto", paths: ["wiki/**/*.md"] },
      { kind: "question.ask" },
    ]);
  });

  test("processor grant overrides participate in the policy hash", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "dome-policy-"));
    const rootB = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(rootA, rootB);
    mkdirSync(join(rootA, ".dome"), { recursive: true });
    mkdirSync(join(rootB, ".dome"), { recursive: true });
    writeFileSync(
      join(rootA, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
`,
      "utf8",
    );
    writeFileSync(
      join(rootB, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
    processors:
      dome.markdown.validate-wikilinks:
        grant:
          read: ["**/*.md"]
`,
      "utf8",
    );

    const policyA = await loadCapabilityPolicy(rootA);
    const policyB = await loadCapabilityPolicy(rootB);

    expect(policyA.ok).toBe(true);
    expect(policyB.ok).toBe(true);
    if (!policyA.ok || !policyB.ok) return;
    expect(computeCapabilityPolicyHash(policyA.value)).not.toBe(
      computeCapabilityPolicyHash(policyB.value),
    );
  });

  test("parses runtime config from .dome/config.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
engine:
  max_iterations: 7
  processor_timeout_ms: 300000
  model_call_timeout_ms: 120000
  auto_commit_workflows: false
  auto_resolve_questions:
    enabled: true
    policies: ["agent-safe", "model-safe", "agent-safe"]
    min_confidence: 0.7
    max_per_tick: 4
git:
  auto_commit_workflows: false
extensions: {}
model_provider:
  kind: command
  command: ["bun", ".dome/model-provider.ts"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtime).toEqual({
      engine: {
        maxIterations: 7,
        executionCap: {
          timeoutMs: 300000,
          modelCallTimeoutMs: 120000,
        },
        autoResolveQuestions: {
          enabled: true,
          policies: ["agent-safe", "model-safe"],
          minConfidence: 0.7,
          maxPerTick: 4,
        },
      },
      git: { auto_commit_workflows: false },
      ledger: { retentionDays: 30 },
      modelProvider: {
        kind: "command",
        command: ["bun", ".dome/model-provider.ts"],
      },
    });
  });

  test("parses an explicit ledger.retention_days, including the 0-disables sentinel", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
ledger:
  retention_days: 0
extensions: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtime.ledger).toEqual({ retentionDays: 0 });
  });

  test("defaults ledger.retention_days to 30 when the vault config omits it", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtime.ledger).toEqual({ retentionDays: 30 });
  });

  test("rejects a negative ledger.retention_days", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
ledger:
  retention_days: -1
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "ledger.retention_days must be a non-negative integer",
    );
  });

  test("rejects unknown ledger config keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
ledger:
  retentoin_days: 30
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "ledger.retentoin_days is not a known ledger config field",
    );
  });

  test("rejects malformed runtime model provider config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
model_provider:
  kind: command
  command: []
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "model_provider.command must be a non-empty string array",
    );
  });

  test("rejects malformed runtime config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
engine:
  max_iterations: 0
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("engine.max_iterations must be a positive integer");
  });

  test("rejects malformed runtime execution caps", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
engine:
  processor_timeout_ms: 0
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "engine.processor_timeout_ms must be a positive integer",
    );
  });

  test("rejects malformed runtime question auto-resolution config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
engine:
  auto_resolve_questions:
    enabled: true
    policies: ["owner-needed"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      'engine.auto_resolve_questions.policies[] must be one of "agent-safe", "model-safe"',
    );
  });

  test("rejects conflicting auto-commit mirrors", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
engine:
  auto_commit_workflows: true
git:
  auto_commit_workflows: false
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must agree");
  });

  test("rejects malformed extension activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  malformed-enabled.bundle:
    enabled: "true"
    grant:
      patch.auto: ["**"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.malformed-enabled.bundle.enabled must be a boolean",
    );
  });

  test("rejects unknown extension-level config keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabledd: true
    grant:
      patch.auto: ["**"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.enabledd is not a known extension config field",
    );
  });

  test("rejects malformed processor grant override blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant: {}
    processors: true
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.processors must be a YAML mapping",
    );
  });

  test("rejects unknown processor-level config keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant: {}
    processors:
      dome.markdown.validate-wikilinks:
        enabled: true
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.processors.dome.markdown.validate-wikilinks.enabled is not a known processor config field",
    );
  });

  test("rejects ambiguous processor grant aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant: {}
    processors:
      dome.markdown.validate-wikilinks:
        grant: {}
        grants: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.processors.dome.markdown.validate-wikilinks must use grant or grants, not both",
    );
  });

  test("accepts opaque per-extension config maps", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.daily:
    enabled: true
    grant: {}
    config:
      timezone: America/New_York
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isExtensionEnabled("dome.daily")).toBe(true);
    expect(result.value.configForExtension("dome.daily")).toEqual({
      timezone: "America/New_York",
    });
    expect(Object.isFrozen(result.value.configForExtension("dome.daily"))).toBe(
      true,
    );
    expect(result.value.configForExtension("missing.bundle")).toEqual({});
  });

  test("extension config participates in the policy hash", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "dome-policy-"));
    const rootB = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(rootA, rootB);
    mkdirSync(join(rootA, ".dome"), { recursive: true });
    mkdirSync(join(rootB, ".dome"), { recursive: true });
    const base = `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
`;
    writeFileSync(join(rootA, ".dome", "config.yaml"), base, "utf8");
    writeFileSync(
      join(rootB, ".dome", "config.yaml"),
      `${base}    config:
      daily_path: notes/{date}.md
`,
      "utf8",
    );

    const policyA = await loadCapabilityPolicy(rootA);
    const policyB = await loadCapabilityPolicy(rootB);

    expect(policyA.ok).toBe(true);
    expect(policyB.ok).toBe(true);
    if (!policyA.ok || !policyB.ok) return;
    expect(computeCapabilityPolicyHash(policyA.value)).not.toBe(
      computeCapabilityPolicyHash(policyB.value),
    );
  });

  test("rejects non-map per-extension config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.daily:
    enabled: true
    grant: {}
    config: true
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("extensions.dome.daily.config must be a YAML mapping");
  });

  test("rejects ambiguous grant aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant: {}
    grants: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must use grant or grants, not both");
  });

  test("rejects unknown grant keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      patch.autoo: ["**"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.grant.patch.autoo is not a known capability grant",
    );
  });

  test("rejects malformed grant values instead of dropping them", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["**/*.md", 123]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.grant.read[1] must be a non-empty string",
    );
  });

  test("rejects scoped question.ask grants until QuestionEffect has a scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.markdown:
    enabled: true
    grant:
      question.ask: ["dome.markdown"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "extensions.dome.markdown.grant.question.ask must be true",
    );
  });

  test("rejects invalid operational grant enum values", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
extensions:
  dome.health:
    enabled: true
    grant:
      outbox.read: ["retry"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      'extensions.dome.health.grant.outbox.read[0] must be one of "pending"',
    );
  });
});

describe("shared_config", () => {
  test("shared_config keys merge as defaults under every extension config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
shared_config:
  daily_path: notes/{date}.md
extensions:
  dome.daily:
    enabled: true
  dome.agent:
    enabled: true
    config:
      daily_path: custom/{date}.md
      ingest_cap: 12
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No own config → the shared default flows through.
    expect(result.value.configForExtension("dome.daily")).toEqual({
      daily_path: "notes/{date}.md",
    });
    // Own config wins per key; other shared keys still flow.
    expect(result.value.configForExtension("dome.agent")).toEqual({
      daily_path: "custom/{date}.md",
      ingest_cap: 12,
    });
    // Extensions never mentioned in the file still see shared defaults.
    expect(result.value.configForExtension("dome.search")).toEqual({
      daily_path: "notes/{date}.md",
    });
  });

  test("shared_config participates in the capability policy hash", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "dome-policy-"));
    const rootB = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(rootA, rootB);
    for (const [root, value] of [
      [rootA, "notes/{date}.md"],
      [rootB, "wiki/dailies/{date}.md"],
    ] as const) {
      mkdirSync(join(root, ".dome"), { recursive: true });
      writeFileSync(
        join(root, ".dome", "config.yaml"),
        `\nshared_config:\n  daily_path: ${value}\nextensions:\n  dome.daily:\n    enabled: true\n`,
        "utf8",
      );
    }

    const policyA = await loadCapabilityPolicy(rootA);
    const policyB = await loadCapabilityPolicy(rootB);
    expect(policyA.ok && policyB.ok).toBe(true);
    if (!policyA.ok || !policyB.ok) return;
    expect(computeCapabilityPolicyHash(policyA.value)).not.toBe(
      computeCapabilityPolicyHash(policyB.value),
    );
  });

  test("rejects a non-mapping shared_config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      "shared_config: 12\n",
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
  });
});
