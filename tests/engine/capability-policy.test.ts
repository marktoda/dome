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
  malformed-enabled.bundle:
    enabled: "true"
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
    expect(result.value.grantsForExtension("malformed-enabled.bundle")).toEqual([]);
    expect(result.value.grantsForExtension("missing.bundle")).toEqual([]);
    expect(result.value.enabledExtensionIds).toEqual(["dome.markdown"]);
    expect(result.value.isExtensionEnabled("dome.markdown")).toBe(true);
    expect(result.value.isExtensionEnabled("disabled.bundle")).toBe(false);
    expect(result.value.isExtensionEnabled("omitted-enabled.bundle")).toBe(false);
    expect(result.value.isExtensionEnabled("malformed-enabled.bundle")).toBe(false);
    expect(result.value.isExtensionEnabled("missing.bundle")).toBe(false);
  });
});
