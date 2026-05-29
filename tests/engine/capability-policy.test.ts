import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCapabilityPolicy } from "../../src/engine/capability-policy";

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
      job.enqueue: ["dome.worker.*"]
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
      kind: "job.enqueue",
      processors: ["dome.worker.*"],
    });
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
git:
  auto_commit_workflows: false
extensions: {}
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
      },
      git: { auto_commit_workflows: false },
    });
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
