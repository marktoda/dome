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
//   - Manifest module paths are confined under `<bundle>/processors/`.
//   - Manifest metadata is bound onto implementation-only processor modules,
//     while legacy full-Processor exports are identity-checked.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  flattenBundleProcessors,
  loadBundleManifestSummaryFromRoots,
  loadBundles,
  loadBundlesFromRoots,
} from "../../src/extensions/loader";
import type { ProcessorContext } from "../../src/core/processor";
import { buildRegistry } from "../../src/processors/registry";

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
    expect(proc.id).toBe("dome.lint.report");
    expect(proc.version).toBe("0.1.1");
    expect(proc.phase).toBe("view");
    expect(proc.triggers.length).toBe(1);
    const trigger = proc.triggers[0];
    if (trigger === undefined) throw new Error("expected one trigger");
    expect(trigger.kind).toBe("command");
  });

  test("heavy whole-vault adoption scanners declare a deterministic timeout above the 10s default", async () => {
    // The silent-wedge fix: dome.markdown.duplicate-detection (and its
    // whole-vault-content-reading adoption siblings) re-read/parse every
    // comparable page on each changed file, which blows the 10s adoption
    // default on a large vault and silently wedges adoption. They must
    // declare an explicit deterministic execution.timeoutMs > 10s; the
    // loader binds it onto the processor, and resolveExecutionPolicy honors
    // it up to the adoption ceiling. validate-wikilinks is deliberately NOT
    // here — it lists paths but only reads CHANGED content, so the default
    // still fits (no blanket bump).
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markdown = result.value.find((b) => b.id === "dome.markdown");
    expect(markdown).toBeDefined();
    if (markdown === undefined) return;

    const markdownHeavyScanners = [
      "dome.markdown.duplicate-detection",
      "dome.markdown.lint-supersession",
      "dome.markdown.broken-images",
    ];
    for (const id of markdownHeavyScanners) {
      const proc = markdown.processors.find((p) => p.id === id);
      expect(proc, `expected ${id} in dome.markdown`).toBeDefined();
      if (proc === undefined) continue;
      expect(proc.phase).toBe("adoption");
      expect(proc.execution?.class).toBe("deterministic");
      expect(proc.execution?.timeoutMs ?? 0).toBeGreaterThan(10_000);
      // Still bounded as the merge gate.
      expect(proc.execution?.timeoutMs ?? Infinity).toBeLessThanOrEqual(60_000);
    }

    // dome.claims.index is the same failure class: a whole-vault adoption
    // scanner (a fact per claim line across wiki+notes) that timed out under
    // the 10s default on the 786-page live vault. It carries the same
    // deterministic-timeout band-aid (see the manifest comment).
    const claims = result.value.find((b) => b.id === "dome.claims");
    expect(claims).toBeDefined();
    if (claims === undefined) return;
    const claimsIndex = claims.processors.find(
      (p) => p.id === "dome.claims.index",
    );
    expect(claimsIndex, "expected dome.claims.index in dome.claims").toBeDefined();
    if (claimsIndex === undefined) return;
    expect(claimsIndex.phase).toBe("adoption");
    expect(claimsIndex.execution?.class).toBe("deterministic");
    expect(claimsIndex.execution?.timeoutMs ?? 0).toBeGreaterThan(10_000);
    expect(claimsIndex.execution?.timeoutMs ?? Infinity).toBeLessThanOrEqual(
      60_000,
    );
  });

  test("flattenBundleProcessors flattens the per-bundle processors array", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flat = flattenBundleProcessors(result.value);
    const lintProc = flat.find((p) => p.id === "dome.lint.report");
    expect(lintProc).toBeDefined();
  });

  test("all shipped processors build one registry and stay bundle-namespaced", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const flat = flattenBundleProcessors(result.value);
    expect(flat.length).toBeGreaterThan(0);
    for (const bundle of result.value) {
      for (const processor of bundle.processors) {
        expect(processor.id.startsWith(`${bundle.id}.`)).toBe(true);
      }
    }

    const registry = buildRegistry(flat);
    expect(registry.ok).toBe(true);
  });

  test("shipped processor modules are implementation-only", async () => {
    const bundleIds = (await readdir(SHIPPED_BUNDLES_ROOT, {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const offenders: string[] = [];
    const metadataKeys = [
      "id",
      "version",
      "phase",
      "triggers",
      "capabilities",
      "execution",
      "inspection",
    ];

    for (const bundleId of bundleIds) {
      const summary = await loadBundleManifestSummaryFromRoots({
        bundleId,
        bundlesRoots: [SHIPPED_BUNDLES_ROOT],
      });
      expect(summary.ok).toBe(true);
      if (!summary.ok || summary.value === null) continue;

      for (const processor of summary.value.processors) {
        const moduleAbs = join(summary.value.bundlePath, processor.module);
        const mod = (await import(pathToFileURL(moduleAbs).href)) as {
          default?: unknown;
        };
        const exported = mod.default;
        if (
          exported === null ||
          exported === undefined ||
          typeof exported !== "object" ||
          typeof (exported as { readonly run?: unknown }).run !== "function"
        ) {
          offenders.push(`${processor.id}: missing implementation run()`);
          continue;
        }
        const staleKeys = metadataKeys.filter((key) =>
          Object.prototype.hasOwnProperty.call(exported, key),
        );
        if (staleKeys.length > 0) {
          offenders.push(`${processor.id}: ${staleKeys.join(",")}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the loaded processor's run() returns a ViewEffect (smoke)", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flat = flattenBundleProcessors(result.value);
    const proc = flat.find((p) => p.id === "dome.lint.report");
    if (proc === undefined) throw new Error("expected dome.lint.report");

    const fakeCtx = {
      input: null,
      snapshot: {
        listMarkdownFiles: async () => [],
        readFile: async () => null,
      },
      projection: {
        diagnostics: () => [],
      },
    } as unknown as ProcessorContext<unknown>;
    const effects = await proc.run(fakeCtx);
    expect(effects.length).toBe(1);
    const e = effects[0];
    if (e === undefined) throw new Error("expected one effect");
    expect(e.kind).toBe("view");
  });

  test("binds manifest execution metadata onto the loaded processor", async () => {
    const root = makeTmpRoot("loader-execution-metadata-");
    const bundleDir = join(root, "test.exec");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });

    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.exec",
        version: "0.1.0",
        processors: [
          {
            id: "test.exec.proc",
            version: "0.1.0",
            phase: "garden",
            triggers: [{ kind: "signal", name: "file.created" }],
            capabilities: [{ kind: "read", paths: ["**/*.md"] }],
            execution: {
              class: "llm",
              timeoutMs: 600_000,
              modelCallTimeoutMs: 180_000,
            },
            module: "processors/proc.ts",
          },
        ],
      }),
    );
    await writeFile(
      join(processorsDir, "proc.ts"),
      `
        export default {
          async run() {
            return [];
          },
        };
      `,
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proc = result.value[0]?.processors[0];
    if (proc === undefined) throw new Error("expected one processor");
    expect(proc.execution?.class).toBe("llm");
    expect(proc.execution?.modelCallTimeoutMs).toBe(180_000);
    expect(proc.triggers.length).toBe(1);
    expect(proc.capabilities.length).toBe(1);
  });

  test("binds manifest metadata onto implementation-only processor modules", async () => {
    const root = makeTmpRoot("loader-implementation-only-");
    const bundleDir = join(root, "test.impl");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });

    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.impl",
        version: "0.1.0",
        processors: [
          {
            id: "test.impl.proc",
            version: "0.2.0",
            phase: "garden",
            triggers: [{ kind: "schedule", cron: "0 6 * * *" }],
            capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
            module: "processors/proc.ts",
          },
        ],
      }),
    );
    await writeFile(
      join(processorsDir, "proc.ts"),
      `
        import { defineProcessorImplementation } from "${REPO_ROOT}/src/core/processor.ts";

        export default defineProcessorImplementation({
          async run() {
            return [];
          },
        });
      `,
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proc = result.value[0]?.processors[0];
    if (proc === undefined) throw new Error("expected one processor");
    expect(proc.id).toBe("test.impl.proc");
    expect(proc.version).toBe("0.2.0");
    expect(proc.phase).toBe("garden");
    expect(proc.triggers).toEqual([{ kind: "schedule", cron: "0 6 * * *" }]);
    expect(proc.capabilities).toEqual([
      { kind: "read", paths: ["wiki/**/*.md"] },
    ]);
  });

  test("rejects stale manifest-owned metadata on full processor exports", async () => {
    const root = makeTmpRoot("loader-stale-metadata-");
    const bundleDir = join(root, "test.stale");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });

    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.stale",
        version: "0.1.0",
        processors: [
          {
            id: "test.stale.proc",
            version: "0.1.0",
            phase: "garden",
            triggers: [{ kind: "signal", name: "file.created" }],
            capabilities: [{ kind: "read", paths: ["wiki/**"] }],
            module: "processors/proc.ts",
          },
        ],
      }),
    );
    await writeFile(
      join(processorsDir, "proc.ts"),
      `
        export default {
          id: "test.stale.proc",
          version: "0.1.0",
          phase: "garden",
          triggers: [{ kind: "signal", name: "file.created" }],
          capabilities: [{ kind: "read", paths: ["notes/**"] }],
          async run() {
            return [];
          },
        };
      `,
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("processor-module-load-failed");
    if (result.error.kind !== "processor-module-load-failed") return;
    expect(result.error.cause).toContain("stale manifest-owned field 'capabilities'");
  });

  test("activeBundleIds filters before manifest reads and processor imports", async () => {
    const root = makeTmpRoot("loader-active-filter-");

    const activeDir = join(root, "active.bundle");
    await mkdir(activeDir, { recursive: true });
    await writeFile(
      join(activeDir, "manifest.json"),
      JSON.stringify({
        id: "active.bundle",
        version: "0.1.0",
        processors: [],
      }),
    );

    const inactiveDir = join(root, "inactive.bundle");
    await mkdir(inactiveDir, { recursive: true });
    await writeFile(
      join(inactiveDir, "manifest.json"),
      "{ this is not valid json",
    );

    const result = await loadBundles({
      bundlesRoot: root,
      activeBundleIds: new Set(["active.bundle"]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((bundle) => bundle.id)).toEqual(["active.bundle"]);
  });

  test("activeBundleIds fail loudly when a requested bundle is absent from the root", async () => {
    const root = makeTmpRoot("loader-active-missing-");
    await writeEmptyBundle(root, "active.bundle");

    const result = await loadBundles({
      bundlesRoot: root,
      activeBundleIds: new Set(["active.bundle", "missing.bundle"]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bundle-not-found");
    if (result.error.kind !== "bundle-not-found") return;
    expect(result.error.bundleIds).toEqual(["missing.bundle"]);
    expect(result.error.bundlesRoots).toEqual([root]);
  });
});

describe("loadBundlesFromRoots — composed roots", () => {
  test("loads bundles from all roots in deterministic bundle-id order", async () => {
    const firstRoot = makeTmpRoot("loader-roots-first-");
    const secondRoot = makeTmpRoot("loader-roots-second-");
    await writeEmptyBundle(firstRoot, "test.zeta");
    await writeEmptyBundle(secondRoot, "test.alpha");

    const result = await loadBundlesFromRoots({
      bundlesRoots: [firstRoot, secondRoot],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((bundle) => bundle.id)).toEqual([
      "test.alpha",
      "test.zeta",
    ]);
  });

  test("later roots override earlier bundles with the same id", async () => {
    const shippedRoot = makeTmpRoot("loader-roots-shipped-");
    const localRoot = makeTmpRoot("loader-roots-local-");
    await writeEmptyBundle(shippedRoot, "test.override", "0.1.0");
    await writeEmptyBundle(localRoot, "test.override", "0.2.0");

    const result = await loadBundlesFromRoots({
      bundlesRoots: [shippedRoot, localRoot],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.id).toBe("test.override");
    expect(result.value[0]?.version).toBe("0.2.0");
    expect(result.value[0]?.bundlePath).toBe(join(localRoot, "test.override"));
  });

  test("activeBundleIds may be satisfied by any composed root", async () => {
    const shippedRoot = makeTmpRoot("loader-roots-active-shipped-");
    const localRoot = makeTmpRoot("loader-roots-active-local-");
    await writeEmptyBundle(shippedRoot, "dome.lint");
    await writeEmptyBundle(localRoot, "custom.local");

    const result = await loadBundlesFromRoots({
      bundlesRoots: [shippedRoot, localRoot],
      activeBundleIds: new Set(["custom.local"]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((bundle) => bundle.id)).toEqual(["custom.local"]);
  });

  test("activeBundleIds fail loudly when absent from all composed roots", async () => {
    const shippedRoot = makeTmpRoot("loader-roots-missing-shipped-");
    const localRoot = makeTmpRoot("loader-roots-missing-local-");
    await writeEmptyBundle(shippedRoot, "dome.lint");
    await writeEmptyBundle(localRoot, "custom.local");

    const result = await loadBundlesFromRoots({
      bundlesRoots: [shippedRoot, localRoot],
      activeBundleIds: new Set(["dome.lint", "missing.bundle"]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bundle-not-found");
    if (result.error.kind !== "bundle-not-found") return;
    expect(result.error.bundleIds).toEqual(["missing.bundle"]);
    expect(result.error.bundlesRoots).toEqual([shippedRoot, localRoot]);
  });

  test("detects page-type collisions after cross-root composition", async () => {
    const firstRoot = makeTmpRoot("loader-roots-page-types-a-");
    const secondRoot = makeTmpRoot("loader-roots-page-types-b-");
    await writeEmptyBundle(firstRoot, "test.page-a");
    await writeFile(
      join(firstRoot, "test.page-a", "page-types.yaml"),
      "extensions:\n  - name: decision\n",
    );
    await writeEmptyBundle(secondRoot, "test.page-b");
    await writeFile(
      join(secondRoot, "test.page-b", "page-types.yaml"),
      "extensions:\n  - name: decision\n",
    );

    const result = await loadBundlesFromRoots({
      bundlesRoots: [firstRoot, secondRoot],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("page-type-collision");
  });

  test("loads external handlers from external-handlers/*.ts", async () => {
    const root = makeTmpRoot("loader-external-handler-");
    await writeExternalHandlerBundle(root, "test.external", "calendar.write");

    const result = await loadBundles({ bundlesRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handler = result.value[0]?.externalHandlers.get("calendar.write");
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    const handled = await handler({
      capability: "calendar.write",
      idempotencyKey: "loader-handler",
      payload: null,
      sourceRefs: [],
      runId: "run-loader",
      attempt: 1,
      signal: new AbortController().signal,
    });
    expect(handled.externalId).toBe("handled:loader-handler");
  });

  test("duplicate external handlers across loaded bundles fail loudly", async () => {
    const root = makeTmpRoot("loader-external-handler-collision-");
    await writeExternalHandlerBundle(root, "test.external-a", "calendar.write");
    await writeExternalHandlerBundle(root, "test.external-b", "calendar.write");

    const result = await loadBundles({ bundlesRoot: root });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "external-handler-collision",
      capability: "calendar.write",
      bundleIds: ["test.external-a", "test.external-b"],
    });
  });

  test("external handlers must default-export a function", async () => {
    const root = makeTmpRoot("loader-external-handler-invalid-");
    await writeEmptyBundle(root, "test.external-invalid");
    const handlersDir = join(root, "test.external-invalid", "external-handlers");
    await mkdir(handlersDir, { recursive: true });
    await writeFile(
      join(handlersDir, "calendar.write.ts"),
      "export default {};",
    );

    const result = await loadBundles({ bundlesRoot: root });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("external-handler-missing-default-export");
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

  test("manifest-id-mismatch when bundle directory disagrees with manifest id", async () => {
    const root = makeTmpRoot("loader-id-mismatch-");
    const bundleDir = join(root, "wrong.dir");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "right.id",
        version: "0.1.0",
        processors: [],
      }),
    );

    const result = await loadBundles({ bundlesRoot: root });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-id-mismatch");
    if (result.error.kind !== "manifest-id-mismatch") return;
    expect(result.error.bundleDir).toBe("wrong.dir");
    expect(result.error.manifestId).toBe("right.id");
  });

  test("manifest-invalid (phase-trigger-mismatch) when a view-phase processor declares a signal trigger", async () => {
    const root = makeTmpRoot("loader-phase-mismatch-");
    const bundleDir = join(root, "test.bad");
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

  test("manifest-invalid (phase-trigger-mismatch) when a view-phase processor declares a schedule trigger", async () => {
    const root = makeTmpRoot("loader-view-schedule-mismatch-");
    const bundleDir = join(root, "test.bad");
    await mkdir(bundleDir, { recursive: true });
    const manifest = {
      id: "test.bad",
      version: "0.1.0",
      processors: [
        {
          id: "test.bad.proc",
          version: "0.1.0",
          phase: "view",
          triggers: [{ kind: "schedule", cron: "0 7 * * MON" }],
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
    expect(result.error.cause.trigger).toBe("schedule");
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

  test("processor-module-load-failed when default export has no run function", async () => {
    const root = makeTmpRoot("loader-no-run-");
    const bundleDir = join(root, "test.no-run");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.no-run",
        version: "0.1.0",
        processors: [
          {
            id: "test.no-run.proc",
            version: "0.1.0",
            phase: "view",
            triggers: [{ kind: "command", name: "no-run" }],
            capabilities: [],
            module: "processors/proc.ts",
          },
        ],
      }),
    );
    await writeFile(join(processorsDir, "proc.ts"), "export default {};\n");

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("processor-module-load-failed");
    if (result.error.kind !== "processor-module-load-failed") return;
    expect(result.error.cause).toContain("has no run function");
  });

  test("processor-module-load-failed when implementation export carries partial manifest metadata", async () => {
    const root = makeTmpRoot("loader-partial-metadata-");
    const bundleDir = join(root, "test.partial");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.partial",
        version: "0.1.0",
        processors: [
          {
            id: "test.partial.proc",
            version: "0.1.0",
            phase: "view",
            triggers: [{ kind: "command", name: "partial" }],
            capabilities: [],
            module: "processors/proc.ts",
          },
        ],
      }),
    );
    await writeFile(
      join(processorsDir, "proc.ts"),
      `
        export default {
          triggers: [{ kind: "command", name: "partial" }],
          async run() {
            return [];
          },
        };
      `,
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("processor-module-load-failed");
    if (result.error.kind !== "processor-module-load-failed") return;
    expect(result.error.cause).toContain("manifest-owned metadata");
    expect(result.error.cause).toContain("without complete legacy identity");
  });

  test("processor-module-load-failed when legacy processor identity drifts from manifest", async () => {
    const root = makeTmpRoot("loader-legacy-identity-drift-");
    const bundleDir = join(root, "test.legacy");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.legacy",
        version: "0.1.0",
        processors: [
          {
            id: "test.legacy.proc",
            version: "0.1.0",
            phase: "view",
            triggers: [{ kind: "command", name: "legacy" }],
            capabilities: [],
            module: "processors/proc.ts",
          },
        ],
      }),
    );
    await writeFile(
      join(processorsDir, "proc.ts"),
      `
        export default {
          id: "test.legacy.other",
          version: "0.1.0",
          phase: "view",
          triggers: [{ kind: "command", name: "legacy" }],
          capabilities: [],
          async run() {
            return [];
          },
        };
      `,
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("processor-module-load-failed");
    if (result.error.kind !== "processor-module-load-failed") return;
    expect(result.error.cause).toContain(
      "manifest declared id 'test.legacy.proc'",
    );
  });

  test("processor-module-path-invalid when module escapes the bundle root", async () => {
    const root = makeTmpRoot("loader-module-escape-");
    const bundleDir = join(root, "test.escape");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.escape",
        version: "0.1.0",
        processors: [
          {
            id: "test.escape.proc",
            version: "0.1.0",
            phase: "view",
            triggers: [{ kind: "command", name: "escape" }],
            capabilities: [],
            module: "../escape.ts",
          },
        ],
      }),
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("processor-module-path-invalid");
    if (result.error.kind !== "processor-module-path-invalid") return;
    expect(result.error.bundleId).toBe("test.escape");
    expect(result.error.modulePath).toBe("../escape.ts");
  });

  test("processor-module-path-invalid when module bypasses processors directory", async () => {
    const root = makeTmpRoot("loader-module-outside-processors-");
    const bundleDir = join(root, "test.outside");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.outside",
        version: "0.1.0",
        processors: [
          {
            id: "test.outside.proc",
            version: "0.1.0",
            phase: "view",
            triggers: [{ kind: "command", name: "outside" }],
            capabilities: [],
            module: "proc.ts",
          },
        ],
      }),
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("processor-module-path-invalid");
    if (result.error.kind !== "processor-module-path-invalid") return;
    expect(result.error.bundleId).toBe("test.outside");
    expect(result.error.modulePath).toBe("proc.ts");
  });

  test("empty bundle with zero declared processors loads successfully", async () => {
    const root = makeTmpRoot("loader-empty-procs-");
    const bundleDir = join(root, "test.empty");
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

  test("empty bundle can contribute page types", async () => {
    const root = makeTmpRoot("loader-page-types-");
    const bundleDir = join(root, "test.page-types");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.page-types",
        version: "0.1.0",
        processors: [],
      }),
    );
    await writeFile(
      join(bundleDir, "page-types.yaml"),
      "extensions:\n  - name: decision\n    frontmatter_extras:\n      owner: required\n",
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.value[0];
    if (b === undefined) throw new Error("expected one bundle");
    expect(b.pageTypes.map((pageType) => pageType.name)).toEqual(["decision"]);
  });

  test("duplicate bundle page types fail loudly", async () => {
    const root = makeTmpRoot("loader-page-type-collision-");
    for (const id of ["test.a", "test.b"]) {
      const bundleDir = join(root, id);
      await mkdir(bundleDir, { recursive: true });
      await writeFile(
        join(bundleDir, "manifest.json"),
        JSON.stringify({
          id,
          version: "0.1.0",
          processors: [],
        }),
      );
      await writeFile(
        join(bundleDir, "page-types.yaml"),
        "extensions:\n  - name: decision\n",
      );
    }

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("page-type-collision");
  });

  test("bundle page types cannot shadow SDK defaults", async () => {
    const root = makeTmpRoot("loader-default-page-type-collision-");
    const bundleDir = join(root, "test.default-page");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "test.default-page",
        version: "0.1.0",
        processors: [],
      }),
    );
    await writeFile(
      join(bundleDir, "page-types.yaml"),
      "extensions:\n  - name: entity\n",
    );

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("page-type-collision");
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

  test("duplicate command triggers across loaded bundles fail registry build", async () => {
    const root = makeTmpRoot("loader-command-collision-");
    await writeCommandBundle(root, {
      bundleId: "test.command-a",
      processorId: "test.command-a.query",
      commandName: "query",
    });
    await writeCommandBundle(root, {
      bundleId: "test.command-b",
      processorId: "test.command-b.query",
      commandName: "query",
    });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const registry = buildRegistry(flattenBundleProcessors(result.value));
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect(registry.error.kind).toBe("duplicate-command-trigger");
    if (registry.error.kind !== "duplicate-command-trigger") return;
    expect(registry.error.commandName).toBe("query");
    expect(registry.error.processors).toEqual([
      "test.command-a.query",
      "test.command-b.query",
    ]);
  });
});

async function writeCommandBundle(
  root: string,
  opts: {
    readonly bundleId: string;
    readonly processorId: string;
    readonly commandName: string;
  },
): Promise<void> {
  const bundleDir = join(root, opts.bundleId);
  const processorsDir = join(bundleDir, "processors");
  await mkdir(processorsDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: opts.bundleId,
      version: "0.1.0",
      processors: [
        {
          id: opts.processorId,
          version: "0.1.0",
          phase: "view",
          triggers: [{ kind: "command", name: opts.commandName }],
          capabilities: [],
          module: "processors/proc.ts",
        },
      ],
    }),
  );
  await writeFile(
    join(processorsDir, "proc.ts"),
    `
      export default {
        async run() {
          return [];
        },
      };
    `,
  );
}

async function writeEmptyBundle(
  root: string,
  bundleId: string,
  version = "0.1.0",
): Promise<void> {
  const bundleDir = join(root, bundleId);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: bundleId,
      version,
      processors: [],
    }),
  );
}

async function writeExternalHandlerBundle(
  root: string,
  bundleId: string,
  capability: string,
): Promise<void> {
  await writeEmptyBundle(root, bundleId);
  const handlersDir = join(root, bundleId, "external-handlers");
  await mkdir(handlersDir, { recursive: true });
  await writeFile(
    join(handlersDir, `${capability}.ts`),
    `
      export default async function handle(input) {
        return { externalId: "handled:" + input.idempotencyKey };
      }
    `,
  );
}

// ----- Manifest-contributed maintenance loops ---------------------------------
//
// Per [[wiki/specs/sdk-surface]] §"Adding a maintenance loop": a bundle may
// declare bundle-scoped loops in its manifest. Required processors must be
// declared by the same bundle (self-contained); optionalProcessors may
// reference foreign ids (inactive contributors render as inactive). The
// cross-bundle first-party loops stay in the core registry by design.

describe("loadBundles — manifest loops", () => {
  async function writeLoopBundle(opts: {
    readonly root: string;
    readonly loops?: unknown;
  }): Promise<void> {
    const bundleDir = join(opts.root, "acme.todo");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });
    await writeFile(
      join(processorsDir, "scan.ts"),
      `
        export default {
          async run() {
            return [];
          },
        };
      `,
    );
    const manifest = {
      id: "acme.todo",
      version: "0.1.0",
      processors: [
        {
          id: "acme.todo.scan",
          version: "0.1.0",
          phase: "garden",
          triggers: [{ kind: "signal", name: "file.created" }],
          capabilities: [],
          module: "processors/scan.ts",
        },
      ],
      ...(opts.loops !== undefined ? { loops: opts.loops } : {}),
    };
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify(manifest),
    );
  }

  const VALID_LOOP = {
    id: "acme.todo.coherence",
    goal: "Todos stay scanned.",
    evidence: [{ kind: "operational", name: "diagnostics" }],
    processors: ["acme.todo.scan"],
    optionalProcessors: ["dome.agent.brief"],
    surfaces: [{ kind: "status", name: "check" }],
    settlement: {
      key: "todo path",
      noOpWhen: "every todo is scanned",
    },
    risks: ["Scan noise."],
  };

  test("a bundle-scoped loop loads with standard settlement checks", async () => {
    const root = makeTmpRoot("loader-loops-");
    await writeLoopBundle({ root, loops: [VALID_LOOP] });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value.find((b) => b.id === "acme.todo");
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    expect(bundle.loops.length).toBe(1);
    const loop = bundle.loops[0];
    if (loop === undefined) return;
    expect(loop.id).toBe("acme.todo.coherence");
    expect(loop.processors).toEqual(["acme.todo.scan"]);
    expect(loop.optionalProcessors).toEqual(["dome.agent.brief"]);
    // Settlement checks default to the standard five.
    expect(loop.settlement.checks.length).toBe(5);
  });

  test("a loop requiring a processor outside its bundle fails the load", async () => {
    const root = makeTmpRoot("loader-loops-foreign-");
    await writeLoopBundle({
      root,
      loops: [{ ...VALID_LOOP, processors: ["dome.agent.ingest"] }],
    });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-invalid");
  });

  test("a malformed loop fails the load", async () => {
    const root = makeTmpRoot("loader-loops-bad-");
    await writeLoopBundle({
      root,
      loops: [{ id: "acme.todo.coherence" }],
    });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-invalid");
  });

  test("a bundle without loops contributes an empty loop list", async () => {
    const root = makeTmpRoot("loader-loops-none-");
    await writeLoopBundle({ root });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.find((b) => b.id === "acme.todo")?.loops).toEqual([]);
  });
});

// ----- Manifest-contributed doctor grant-entry requirements ---------------------
//
// Per [[wiki/gotchas/operator-surfaces-enumerate-first-party]]: the
// grant-entry probe table converts from a core constant to a manifest
// `doctor:` contribution. Entries are self-contained (processorId must be
// declared by this bundle); the runtime composes active bundles' entries and
// `dome doctor` evaluates them generically.

describe("loadBundles — manifest doctor grant entries", () => {
  async function writeDoctorBundle(opts: {
    readonly root: string;
    readonly doctor?: unknown;
  }): Promise<void> {
    const bundleDir = join(opts.root, "acme.todo");
    const processorsDir = join(bundleDir, "processors");
    await mkdir(processorsDir, { recursive: true });
    await writeFile(
      join(processorsDir, "scan.ts"),
      "export default { async run() { return []; } };\n",
    );
    const manifest = {
      id: "acme.todo",
      version: "0.1.0",
      processors: [
        {
          id: "acme.todo.scan",
          version: "0.1.0",
          phase: "garden",
          triggers: [{ kind: "signal", name: "file.created" }],
          capabilities: [{ kind: "read", paths: ["todos/**/*.md"] }],
          module: "processors/scan.ts",
        },
      ],
      ...(opts.doctor !== undefined ? { doctor: opts.doctor } : {}),
    };
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify(manifest),
    );
  }

  const VALID_DOCTOR = {
    grantEntries: [
      {
        processorId: "acme.todo.scan",
        entries: [{ kind: "read", target: "todos/inbox.md" }],
        why: "the scan never sees the inbox",
        recovery: 'Add "todos/inbox.md" to extensions.acme.todo.grant.read.',
      },
    ],
  };

  test("a doctor grant-entry requirement loads onto the bundle", async () => {
    const root = makeTmpRoot("loader-doctor-");
    await writeDoctorBundle({ root, doctor: VALID_DOCTOR });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value.find((b) => b.id === "acme.todo");
    expect(bundle?.doctorGrantEntries.length).toBe(1);
    const requirement = bundle?.doctorGrantEntries[0];
    expect(requirement?.processorId).toBe("acme.todo.scan");
    expect(requirement?.entries[0]?.target).toBe("todos/inbox.md");
  });

  test("a requirement naming a foreign processor fails the load", async () => {
    const root = makeTmpRoot("loader-doctor-foreign-");
    await writeDoctorBundle({
      root,
      doctor: {
        grantEntries: [
          { ...VALID_DOCTOR.grantEntries[0], processorId: "dome.agent.brief" },
        ],
      },
    });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("manifest-invalid");
  });

  test("a bundle without a doctor block contributes no requirements", async () => {
    const root = makeTmpRoot("loader-doctor-none-");
    await writeDoctorBundle({ root });

    const result = await loadBundles({ bundlesRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.find((b) => b.id === "acme.todo")?.doctorGrantEntries)
      .toEqual([]);
  });

  test("the shipped first-party manifests carry the converted probe table", async () => {
    const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byProcessor = new Set(
      result.value.flatMap((bundle) =>
        bundle.doctorGrantEntries.map((req) => req.processorId),
      ),
    );
    // The seven entries that moved out of FIRST_PARTY_GRANT_ENTRY_REQUIREMENTS.
    for (const processorId of [
      "dome.daily.attention-discount",
      "dome.agent.brief",
      "dome.agent.preference-signals",
      "dome.agent.preference-promotion-answer",
      "dome.markdown.core-size",
      "dome.markdown.page-status",
    ]) {
      expect(byProcessor.has(processorId)).toBe(true);
    }
  });
});
