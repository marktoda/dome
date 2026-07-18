import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeCapabilityPolicyHash,
  DEFAULT_RUNTIME_CONFIG,
  loadCapabilityPolicy,
  parseCapabilityPolicy,
} from "../../src/engine/core/capability-policy";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("loadCapabilityPolicy", () => {
  test("parses canonical content scope and includes it in the policy hash", () => {
    const broad = parseCapabilityPolicy(`
content_scope:
  version: 1
  include: ["**/*.md"]
  exclude: [".dome/**", ".git/**"]
`);
    const narrow = parseCapabilityPolicy(`
content_scope:
  version: 1
  include: ["notes/**/*.md"]
  exclude: [".dome/**", ".git/**"]
`);
    expect(broad.ok).toBe(true);
    expect(narrow.ok).toBe(true);
    if (!broad.ok || !narrow.ok) return;
    expect(broad.value.contentScope).toEqual({
      version: 1,
      include: ["**/*.md"],
      exclude: [".dome/**", ".git/**"],
    });
    expect(computeCapabilityPolicyHash(broad.value)).not.toBe(computeCapabilityPolicyHash(narrow.value));

    const missing = parseCapabilityPolicy("grants: standard\n");
    expect(missing.ok && missing.value.contentScope).toBeNull();
    const noncanonical = parseCapabilityPolicy(`
content_scope:
  version: 1
  include: ["**/*.md", "**/*.md"]
  exclude: []
`);
    expect(noncanonical).toEqual({
      ok: false,
      error: ".dome/config.yaml content_scope.include must be sorted and unique",
    });
  });

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
      proposals.read: true
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
    expect(grants).toContainEqual({ kind: "proposals.read" });
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
      ledger: {},
      modelProvider: {
        kind: "command",
        command: ["bun", ".dome/model-provider.ts"],
      },
    });
  });

  test("parses ledger.retention_days from .dome/config.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
ledger:
  retention_days: 30
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtime.ledger.retentionDays).toBe(30);
  });

  test("absent ledger config leaves retentionDays undefined", async () => {
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
    expect(result.value.runtime.ledger.retentionDays).toBeUndefined();
  });

  test.each([
    ["0", "0"],
    ["-1", "-1"],
    ['"x"', '"x"'],
  ])(
    "rejects malformed ledger.retention_days (%s)",
    async (_label, yamlValue) => {
      const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
      roots.push(root);
      mkdirSync(join(root, ".dome"), { recursive: true });
      writeFileSync(
        join(root, ".dome", "config.yaml"),
        `
ledger:
  retention_days: ${yamlValue}
`,
        "utf8",
      );

      const result = await loadCapabilityPolicy(root);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain(
        "ledger.retention_days must be a positive integer",
      );
    },
  );

  test("rejects unknown ledger config keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
ledger:
  vacuum: true
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "ledger.vacuum is not a known ledger config field",
    );
  });

  test("DEFAULT_RUNTIME_CONFIG.ledger has no retention configured", () => {
    expect(DEFAULT_RUNTIME_CONFIG.ledger).toEqual({});
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

describe("grants: standard preset", () => {
  test("expands to the shipped first-party defaults for enabled bundles", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    // No enumerated grant blocks anywhere — just enabled flags + the preset.
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: standard
extensions:
  dome.daily:
    enabled: true
  dome.agent:
    enabled: true
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bundle-level default grant flows through (spot-check dome.daily's
    // questions.read, which its compose-blocks processor needs).
    expect(result.value.grantsForExtension("dome.daily")).toContainEqual({
      kind: "questions.read",
    });
    expect(result.value.grantsForExtension("dome.daily")).toContainEqual({
      kind: "graph.write",
      namespaces: ["dome.daily.*"],
    });
    // Per-processor REPLACEMENT grants ride the preset: dome.agent's
    // preference-promotion-answer is the gated core.md writer.
    expect(
      result.value.grantsForProcessor(
        "dome.agent",
        "dome.agent.preference-promotion-answer",
      ),
    ).toEqual([
      { kind: "read", paths: ["core.md", "preferences/signals.md"] },
      { kind: "patch.auto", paths: ["core.md", "preferences/signals.md"] },
    ]);
    // A dome.agent processor without a replacement grant falls back to the
    // bundle grant (which carries the $2/day model.invoke pool).
    expect(
      result.value.grantsForProcessor("dome.agent", "dome.agent.ingest"),
    ).toContainEqual({ kind: "model.invoke", maxDailyCostUsd: 2 });
  });

  test("an explicit grant block wins entirely — preset ignored for that extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: standard
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["notes/only.md"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ONLY the explicit block — no preset defaults merged in (no questions.read,
    // no graph.write from the shipped default).
    expect(result.value.grantsForExtension("dome.daily")).toEqual([
      { kind: "read", paths: ["notes/only.md"] },
    ]);
  });

  test("an explicit processors block alone opts the extension out of the preset", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: standard
extensions:
  dome.daily:
    enabled: true
    processors:
      dome.daily.compose-blocks:
        grant:
          read: ["wiki/**/*.md"]
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bundle grant is empty (no `grant:` block present, preset ignored),
    // and the only processor grant is the explicit replacement.
    expect(result.value.grantsForExtension("dome.daily")).toEqual([]);
    expect(
      result.value.grantsForProcessor(
        "dome.daily",
        "dome.daily.compose-blocks",
      ),
    ).toEqual([{ kind: "read", paths: ["wiki/**/*.md"] }]);
  });

  test("preset grants nothing to third-party / unknown enabled extensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: standard
extensions:
  acme.calendar-sync:
    enabled: true
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isExtensionEnabled("acme.calendar-sync")).toBe(true);
    expect(result.value.grantsForExtension("acme.calendar-sync")).toEqual([]);
  });

  test("accepts grants: standard as a known top-level key", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: standard
extensions: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(true);
  });

  test("rejects any grants preset other than standard, loudly", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: everything
extensions: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('grants must be "standard"');
  });

  test("still rejects unknown top-level keys alongside the preset", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(root);
    mkdirSync(join(root, ".dome"), { recursive: true });
    writeFileSync(
      join(root, ".dome", "config.yaml"),
      `
grants: standard
grantz: standard
extensions: {}
`,
      "utf8",
    );

    const result = await loadCapabilityPolicy(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "grantz is not a known top-level config field",
    );
  });

  test("the expanded preset grants participate in the policy hash", async () => {
    // A vault with the preset (dome.daily gets its shipped default grants)
    // must hash differently from the same vault WITHOUT the preset (dome.daily
    // enabled but grantless) — proving the expanded concrete grants reach the
    // hash, so a shipped-default change invalidates capability caches.
    const rootWith = mkdtempSync(join(tmpdir(), "dome-policy-"));
    const rootWithout = mkdtempSync(join(tmpdir(), "dome-policy-"));
    roots.push(rootWith, rootWithout);
    mkdirSync(join(rootWith, ".dome"), { recursive: true });
    mkdirSync(join(rootWithout, ".dome"), { recursive: true });
    writeFileSync(
      join(rootWith, ".dome", "config.yaml"),
      `\ngrants: standard\nextensions:\n  dome.daily:\n    enabled: true\n`,
      "utf8",
    );
    writeFileSync(
      join(rootWithout, ".dome", "config.yaml"),
      `\nextensions:\n  dome.daily:\n    enabled: true\n`,
      "utf8",
    );

    const policyWith = await loadCapabilityPolicy(rootWith);
    const policyWithout = await loadCapabilityPolicy(rootWithout);
    expect(policyWith.ok && policyWithout.ok).toBe(true);
    if (!policyWith.ok || !policyWithout.ok) return;
    expect(computeCapabilityPolicyHash(policyWith.value)).not.toBe(
      computeCapabilityPolicyHash(policyWithout.value),
    );
  });
});
