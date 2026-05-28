// Phase 8 — bundle loader tests.
//
// Covers:
//   - Loading the shipped `assets/extensions/dome.lint/` bundle:
//     manifest.yaml parses, the declared processor module dynamic-imports,
//     and the bound `Processor` carries the expected (id, version, phase).
//   - Manifest invalid-shape rejection (Zod failure surfaces as
//     `manifest-invalid` with `cause.kind === "invalid-shape"`).
//   - Phase × trigger matrix violation rejection
//     (per [[wiki/matrices/processor-phase-x-trigger]]: view-phase + signal
//     trigger is rejected).
//   - Root-not-found rejection.
//   - `flattenBundleProcessors` flattens correctly.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  flattenBundleProcessors,
  loadBundles,
} from "../../src/extensions/loader";
import type { ProcessorContext } from "../../src/core/processor";

// ----- Paths ---------------------------------------------------------------
//
// The shipped `assets/extensions/` directory, relative to the repo root.
// `fileURLToPath(import.meta.url)` resolves this test file's absolute path
// at runtime; walking up two directories lands at the repo root.

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

// ----- Cleanup -------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined) await rm(d, { recursive: true, force: true });
  }
});

function makeTmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// ----- Happy path against the shipped bundle -------------------------------

describe("loadBundles — shipped dome.lint bundle", () => {
  test("loads the bundle; processor (id, version, phase) match the manifest", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundles = result.value;
    // The shipped tree may grow over time; assert >= 1 and find dome.lint by id.
    expect(bundles.length).toBeGreaterThanOrEqual(1);
    const lint = bundles.find((b) => b.id === "dome.lint");
    expect(lint).toBeDefined();
    if (lint === undefined) return;
    expect(lint.version).toBe("0.1.0");
    expect(lint.processors.length).toBe(1);

    const proc = lint.processors[0];
    if (proc === undefined) throw new Error("expected one processor");
    expect(proc.id).toBe("dome.lint.markdown-format");
    expect(proc.version).toBe("0.1.0");
    expect(proc.phase).toBe("view");
    expect(proc.triggers.length).toBe(1);
    const trigger = proc.triggers[0];
    if (trigger === undefined) throw new Error("expected one trigger");
    expect(trigger.kind).toBe("command");
  });

  test("flattenBundleProcessors flattens the per-bundle processors array", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flat = flattenBundleProcessors(result.value);
    const lintProc = flat.find((p) => p.id === "dome.lint.markdown-format");
    expect(lintProc).toBeDefined();
  });

  test("the loaded processor's run() returns a ViewEffect (smoke)", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flat = flattenBundleProcessors(result.value);
    const proc = flat.find((p) => p.id === "dome.lint.markdown-format");
    if (proc === undefined) throw new Error("expected dome.lint.markdown-format");

    // The processor doesn't read ctx — we can pass a minimal placeholder
    // for the smoke check. The cast through `unknown` skips the structural
    // requirements of `ProcessorContext` since `run` is typed as
    // `(ctx) => Promise<Effect[]>` and the demo body ignores ctx entirely.
    const fakeCtx = {} as unknown as ProcessorContext<unknown>;
    const effects = await proc.run(fakeCtx);
    expect(effects.length).toBe(1);
    const e = effects[0];
    if (e === undefined) throw new Error("expected one effect");
    expect(e.kind).toBe("view");
  });
});

// ----- Error variants ------------------------------------------------------

describe("loadBundles — error variants", () => {
  test("root-not-found when the path doesn't exist", async () => {
    const result = await loadBundles({
      bundlesRoot: "/nonexistent/path/that/cannot/exist/__dome_test__",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("root-not-found");
  });

  test("manifest-invalid when manifest fails Zod shape (missing id)", async () => {
    const root = makeTmpRoot("loader-invalid-shape-");
    const bundleDir = join(root, "broken");
    await mkdir(bundleDir, { recursive: true });
    // Missing required `id` field.
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({ version: "0.1.0", processors: [] }),
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-invalid");
    if (result.error.kind !== "manifest-invalid") return;
    expect(result.error.bundleId).toBe("broken");
    expect(result.error.cause.kind).toBe("invalid-shape");
  });

  test("manifest-invalid (phase-trigger-mismatch) when a view-phase processor declares a signal trigger", async () => {
    const root = makeTmpRoot("loader-phase-mismatch-");
    const bundleDir = join(root, "bad-bundle");
    await mkdir(bundleDir, { recursive: true });
    // view + signal violates the matrix.
    const manifest = {
      id: "test.bad",
      version: "0.1.0",
      processors: [
        {
          id: "test.bad.proc",
          version: "0.1.0",
          phase: "view",
          triggers: [{ kind: "signal", name: "file.created" }],
          capabilities: [],
          module: "processors/x.ts",
        },
      ],
    };
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify(manifest),
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-invalid");
    if (result.error.kind !== "manifest-invalid") return;
    expect(result.error.cause.kind).toBe("phase-trigger-mismatch");
    if (result.error.cause.kind !== "phase-trigger-mismatch") return;
    expect(result.error.cause.processorId).toBe("test.bad.proc");
    expect(result.error.cause.phase).toBe("view");
    expect(result.error.cause.trigger).toBe("signal");
  });

  test("manifest-read-failed when neither manifest.yaml nor manifest.json exists", async () => {
    const root = makeTmpRoot("loader-no-manifest-");
    const bundleDir = join(root, "naked-bundle");
    await mkdir(bundleDir, { recursive: true });
    // No manifest written.

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-read-failed");
    if (result.error.kind !== "manifest-read-failed") return;
    expect(result.error.bundleId).toBe("naked-bundle");
  });

  test("empty bundle with zero declared processors loads successfully", async () => {
    const root = makeTmpRoot("loader-empty-procs-");
    const bundleDir = join(root, "empty-bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.empty",
        version: "0.1.0",
        processors: [],
      }),
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(1);
    const b = result.value[0];
    if (b === undefined) throw new Error("expected one bundle");
    expect(b.id).toBe("test.empty");
    expect(b.processors.length).toBe(0);
  });

  // Regression: pre-fix, Dirent.isDirectory() reported false for
  // symlink-to-directory entries, so symlinked bundles were silently
  // skipped — the loader returned an empty result. Real-world use
  // cases for symlinks: dev-mode (symlink into an SDK checkout),
  // shared bundles across vaults, and the test harness's bundle
  // install strategy. The fix stat()s each symlink to follow it.
  test("symlinked bundle directory is loaded (follows symlinks)", async () => {
    const root = makeTmpRoot("loader-symlink-");
    const target = join(SHIPPED_BUNDLES_ROOT, "dome.markdown");
    const symlinkPath = join(root, "dome.markdown");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, symlinkPath, "dir");

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(1);
    const b = result.value[0];
    if (b === undefined) throw new Error("expected one bundle");
    expect(b.id).toBe("dome.markdown");
    const procIds = b.processors.map((p) => p.id).sort();
    expect(procIds).toContain("dome.markdown.normalize-frontmatter");
    expect(procIds).toContain("dome.markdown.validate-wikilinks");
  });
});
