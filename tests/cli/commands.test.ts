import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { domeInit } from "../../src/cli/commands/init";
import { domeReconcile } from "../../src/cli/commands/reconcile";
import { domeDoctor } from "../../src/cli/commands/doctor";

describe("CLI commands", () => {
  test("reconcile on a freshly-init'd vault returns ok", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const r = await domeReconcile(target);
      expect(r.ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor on a clean vault exits 0", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const r = await domeDoctor(target);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.exitCode).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor flags a frontmatter/directory mismatch", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      // Write a page directly to disk with mismatched type
      await writeFile(join(target, "wiki", "entities", "bogus.md"), "---\ntype: concept\n---\n# Bogus");
      const r = await domeDoctor(target);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.exitCode).toBe(1);
        expect(r.value.violations.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
