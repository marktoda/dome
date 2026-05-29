import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  parseManifest,
  type Manifest,
} from "../../src/extensions/manifest-schema";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(THIS_FILE)));
const EXTENSIONS_ROOT = join(REPO_ROOT, "assets", "extensions");
const BUILT_IN_MATRIX = join(
  REPO_ROOT,
  "docs",
  "wiki",
  "matrices",
  "built-in-extensions-x-phase.md",
);
const BUNDLE_SHAPE_MATRIX = join(
  REPO_ROOT,
  "docs",
  "wiki",
  "matrices",
  "extension-bundle-shape.md",
);

type BuiltInMatrixRow = {
  readonly bundle: string;
  readonly status: string;
  readonly adoption: string;
  readonly garden: string;
  readonly view: string;
};

type BundleShapeRow = {
  readonly bundle: string;
  readonly status: string;
  readonly pageTypes: string;
  readonly processors: string;
  readonly capabilityGrants: string;
};

type ShippedBundle = {
  readonly id: string;
  readonly manifest: Manifest;
};

describe("first-party bundle docs lockstep", () => {
  test("built-in extension phase matrix matches shipped manifests", async () => {
    const bundles = await shippedBundles();
    const rows = activeBuiltInRows(await builtInMatrixRows());

    expect(sorted([...rows.keys()])).toEqual(sorted(bundles.map((b) => b.id)));

    for (const bundle of bundles) {
      const row = rows.get(bundle.id);
      expect(row, `missing built-in matrix row for ${bundle.id}`).toBeDefined();
      if (row === undefined) continue;

      expect(shortProcessorNamesByPhase(bundle.manifest, "adoption")).toEqual(
        shippedProcessorNames(row.adoption),
      );
      expect(shortProcessorNamesByPhase(bundle.manifest, "garden")).toEqual(
        shippedProcessorNames(row.garden),
      );
      expect(shortProcessorNamesByPhase(bundle.manifest, "view")).toEqual(
        shippedProcessorNames(row.view),
      );
    }
  });

  test("extension bundle shape matrix matches shipped manifests", async () => {
    const bundles = await shippedBundles();
    const rows = activeBundleShapeRows(await bundleShapeRows());

    expect(sorted([...rows.keys()])).toEqual(sorted(bundles.map((b) => b.id)));

    for (const bundle of bundles) {
      const row = rows.get(bundle.id);
      expect(row, `missing bundle-shape matrix row for ${bundle.id}`).toBeDefined();
      if (row === undefined) continue;

      const expectedModules = shippedProcessorFiles(row.processors);
      const actualModules = sorted(
        bundle.manifest.processors.map((processor) =>
          basename(processor.module),
        ),
      );
      expect(actualModules).toEqual(expectedModules);

      const expectedPageTypes = shippedCodeSpans(row.pageTypes);
      expect(await pageTypeNames(bundle.id)).toEqual(expectedPageTypes);

      const actualCapabilityKinds = sorted([
        ...new Set(
          bundle.manifest.processors.flatMap((processor) =>
            processor.capabilities.map((capability) => capability.kind),
          ),
        ),
      ]);
      for (const kind of actualCapabilityKinds) {
        expect(
          row.capabilityGrants,
          `${bundle.id} capability grants cell must mention ${kind}`,
        ).toContain(kind);
      }
    }
  });
});

async function shippedBundles(): Promise<ReadonlyArray<ShippedBundle>> {
  const dirs = await readdir(EXTENSIONS_ROOT, { withFileTypes: true });
  const bundles: ShippedBundle[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const manifest = await readManifest(join(EXTENSIONS_ROOT, dir.name));
    bundles.push(Object.freeze({ id: manifest.id, manifest }));
  }
  return Object.freeze(bundles.sort((a, b) => a.id.localeCompare(b.id)));
}

async function readManifest(bundleRoot: string): Promise<Manifest> {
  const raw = parseYaml(await readFile(join(bundleRoot, "manifest.yaml"), "utf8"));
  const parsed = parseManifest(raw);
  expect(parsed.ok, `manifest failed to parse at ${bundleRoot}`).toBe(true);
  if (!parsed.ok) {
    throw new Error(`manifest failed to parse at ${bundleRoot}: ${parsed.error.kind}`);
  }
  return parsed.value;
}

async function pageTypeNames(bundleId: string): Promise<ReadonlyArray<string>> {
  try {
    const raw = parseYaml(
      await readFile(
        join(EXTENSIONS_ROOT, bundleId, "page-types.yaml"),
        "utf8",
      ),
    ) as { readonly extensions?: ReadonlyArray<{ readonly name?: unknown }> };
    return sorted(
      (raw.extensions ?? [])
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === "string"),
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return Object.freeze([]);
    }
    throw error;
  }
}

async function builtInMatrixRows(): Promise<ReadonlyArray<BuiltInMatrixRow>> {
  const text = await readFile(BUILT_IN_MATRIX, "utf8");
  return Object.freeze(
    markdownTableRows(text).map((cells) =>
      Object.freeze({
        bundle: bundleName(cells[0] ?? ""),
        status: statusValue(cells[1] ?? ""),
        adoption: cleanCell(cells[2] ?? ""),
        garden: cleanCell(cells[3] ?? ""),
        view: cleanCell(cells[4] ?? ""),
      }),
    ),
  );
}

async function bundleShapeRows(): Promise<ReadonlyArray<BundleShapeRow>> {
  const text = await readFile(BUNDLE_SHAPE_MATRIX, "utf8");
  return Object.freeze(
    markdownTableRows(text).map((cells) =>
      Object.freeze({
        bundle: bundleName(cells[0] ?? ""),
        status: statusValue(cells[1] ?? ""),
        pageTypes: cleanCell(cells[2] ?? ""),
        processors: cleanCell(cells[4] ?? ""),
        capabilityGrants: cleanCell(cells[6] ?? ""),
      }),
    ),
  );
}

function activeBuiltInRows(
  rows: ReadonlyArray<BuiltInMatrixRow>,
): ReadonlyMap<string, BuiltInMatrixRow> {
  return activeRows(rows);
}

function activeBundleShapeRows(
  rows: ReadonlyArray<BundleShapeRow>,
): ReadonlyMap<string, BundleShapeRow> {
  return activeRows(rows);
}

function activeRows<T extends { readonly bundle: string; readonly status: string }>(
  rows: ReadonlyArray<T>,
): ReadonlyMap<string, T> {
  return new Map(
    rows
      .filter((row) => row.bundle.startsWith("dome."))
      .filter((row) => row.status === "shipped" || row.status === "partially shipped")
      .map((row) => [row.bundle, row]),
  );
}

function markdownTableRows(text: string): ReadonlyArray<ReadonlyArray<string>> {
  return Object.freeze(
    text
      .split("\n")
      .filter((line) => line.startsWith("| **`"))
      .map((line) =>
        Object.freeze(
          line
            .slice(1, -1)
            .split("|")
            .map((cell) => cleanCell(cell)),
        ),
      ),
  );
}

function shortProcessorNamesByPhase(
  manifest: Manifest,
  phase: "adoption" | "garden" | "view",
): ReadonlyArray<string> {
  return sorted(
    manifest.processors
      .filter((processor) => processor.phase === phase)
      .map((processor) => processor.id.replace(`${manifest.id}.`, "")),
  );
}

function shippedProcessorNames(cell: string): ReadonlyArray<string> {
  return sorted(
    shippedCodeSpans(cell).filter(
      (name) => !name.endsWith(".ts") && /^[-a-z0-9]+$/.test(name),
    ),
  );
}

function shippedProcessorFiles(cell: string): ReadonlyArray<string> {
  return sorted(shippedCodeSpans(cell).filter((name) => name.endsWith(".ts")));
}

function shippedCodeSpans(cell: string): ReadonlyArray<string> {
  const normalized = cleanCell(cell);
  if (/^(?:planned|future):/i.test(normalized)) return Object.freeze([]);
  const shippedPart = normalized.split(/;\s*(?:planned|future):/i)[0] ?? "";
  const withoutPrefix = shippedPart.replace(/^shipped:\s*/i, "");
  const out: string[] = [];
  for (const match of withoutPrefix.matchAll(/`([^`]+)`/g)) {
    const value = match[1];
    if (value !== undefined) out.push(value);
  }
  return Object.freeze(out);
}

function bundleName(cell: string): string {
  return cleanCell(cell).match(/`([^`]+)`/)?.[1] ?? "";
}

function statusValue(cell: string): string {
  return cleanCell(cell).match(/`([^`]+)`/)?.[1] ?? cleanCell(cell);
}

function cleanCell(cell: string): string {
  return cell.trim().replace(/<br\s*\/?>/gi, " ");
}

function sorted(values: Iterable<string>): ReadonlyArray<string> {
  return Object.freeze([...values].sort((a, b) => a.localeCompare(b)));
}
