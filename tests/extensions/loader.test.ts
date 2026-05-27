import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadExtensionBundles } from "../../src/extensions/loader";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures-loader");

async function makeBundle(name: string, files: Record<string, string>): Promise<void> {
  const dir = join(FIXTURE_ROOT, ".dome/extensions", name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = join(dir, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

beforeEach(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
  await mkdir(FIXTURE_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("loadExtensionBundles", () => {
  test("returns empty array when .dome/extensions/ does not exist", async () => {
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test("loads a single valid bundle", async () => {
    await makeBundle("dailies", { "manifest.yaml": "name: dailies\nversion: 1.0.0\n" });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0].name).toBe("dailies");
      expect(r.value[0].version).toBe("1.0.0");
    }
  });

  test("loads multiple bundles in alphabetical order", async () => {
    await makeBundle("zebra", { "manifest.yaml": "name: zebra\nversion: 1.0.0\n" });
    await makeBundle("alpha", { "manifest.yaml": "name: alpha\nversion: 1.0.0\n" });
    await makeBundle("middle", { "manifest.yaml": "name: middle\nversion: 1.0.0\n" });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((b) => b.name)).toEqual(["alpha", "middle", "zebra"]);
    }
  });

  test("rejects bundle with name-mismatch", async () => {
    await makeBundle("dailies", { "manifest.yaml": "name: WRONG\nversion: 1.0.0\n" });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("bundle-load-failure");
      if (r.error.kind === "bundle-load-failure") {
        expect(r.error.detail).toBe("name-mismatch");
      }
    }
  });

  test("rejects bundle with missing manifest", async () => {
    const dir = join(FIXTURE_ROOT, ".dome/extensions", "orphan");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "preamble.md"), "Hello\n", "utf8");
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "bundle-load-failure") {
      expect(r.error.detail).toBe("manifest-missing");
    }
  });

  test("captures bundle contribution paths (page-types, preamble, workflows, hooks, cli)", async () => {
    await makeBundle("rich", {
      "manifest.yaml": "name: rich\nversion: 1.0.0\n",
      "page-types.yaml": "extensions:\n  - name: rich-page\n",
      "preamble.md": "# Rich preamble\n",
      "workflows/foo.md": "---\ntools: [readDocument]\n---\nHello\n",
      "hooks/bar.yaml": "event: document.written\nworkflow: ingest\n",
      "cli/baz.ts": "export const command = { name: 'baz' };\n",
    });
    const r = await loadExtensionBundles(FIXTURE_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const b = r.value[0];
      expect(b.pageTypesPath).toBeTruthy();
      expect(b.preamblePath).toBeTruthy();
      expect(b.workflowPaths).toHaveLength(1);
      expect(b.hookPaths).toHaveLength(1);
      expect(b.cliPaths).toHaveLength(1);
    }
  });
});
