// engine-import-direction: the lockstep fence behind
// docs/wiki/matrices/engine-module-map.md ([[wiki/linters/engine-import-direction]]).
//
// Three assertions, all driven by the matrix's "Module → layer" table:
//   1. Placement lockstep — every matrix row exists on disk at
//      src/engine/<layer>/<module>.ts, and every .ts file under src/engine/
//      has a matrix row.
//   2. Import direction — no engine module imports a module from a
//      higher-ranked layer (core < garden < operational < host). Same-layer
//      imports (including cycles) are allowed.
//   3. No loose files — a .ts file directly under src/engine/ fails.

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(THIS_FILE)));
const MATRIX_PATH = join(
  REPO_ROOT,
  "docs",
  "wiki",
  "matrices",
  "engine-module-map.md",
);

const LAYER_RANK: Record<string, number> = {
  core: 0,
  garden: 1,
  operational: 2,
  host: 3,
};

type MatrixRow = {
  readonly module: string;
  readonly layer: string;
};

async function matrixRows(): Promise<MatrixRow[]> {
  const text = await readFile(MATRIX_PATH, "utf8");
  const rows: MatrixRow[] = [];
  // Rows in the "Module → layer" table look like: | `module` | `layer` | role |
  const rowPattern = /^\|\s*`([a-z0-9-]+)`\s*\|\s*`(core|garden|operational|host)`\s*\|/;
  for (const line of text.split("\n")) {
    const match = rowPattern.exec(line);
    if (match) {
      rows.push({ module: match[1] ?? "", layer: match[2] ?? "" });
    }
  }
  return rows;
}

async function engineFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Glob("src/engine/**/*.ts").scan(REPO_ROOT)) {
    files.push(file);
  }
  return files.sort();
}

describe("engine module map lockstep", () => {
  test("every matrix row exists on disk and every engine file has a row", async () => {
    const rows = await matrixRows();
    expect(rows.length).toBeGreaterThan(0);

    const declared = new Set(
      rows.map((row) => `src/engine/${row.layer}/${row.module}.ts`),
    );
    const onDisk = new Set(await engineFiles());

    const missingOnDisk = [...declared].filter((path) => !onDisk.has(path));
    const missingInMatrix = [...onDisk].filter((path) => !declared.has(path));

    expect(missingOnDisk).toEqual([]);
    expect(missingInMatrix).toEqual([]);
  });

  test("no .ts file sits directly under src/engine/", async () => {
    const loose = (await engineFiles()).filter(
      (path) => path.split("/").length === 3,
    );
    expect(loose).toEqual([]);
  });

  test("no engine module imports a higher-ranked layer", async () => {
    const rows = await matrixRows();
    const layerByModule = new Map(rows.map((row) => [row.module, row.layer]));
    const violations: string[] = [];

    for (const file of await engineFiles()) {
      const parts = file.split("/");
      const fileLayer = parts[2] ?? "";
      const fileRank = LAYER_RANK[fileLayer];
      if (fileRank === undefined) {
        violations.push(`${file}: not in a known layer directory`);
        continue;
      }

      const text = await readFile(join(REPO_ROOT, file), "utf8");
      // Static and dynamic relative imports: from "./x", from "../layer/x", import("...").
      const importPattern = /(?:from\s+|import\()"(\.{1,2}\/[^"]+)"/g;
      for (const match of text.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        const resolved = normalize(join(dirname(file), specifier));
        if (!resolved.startsWith("src/engine/")) continue;
        const segments = resolved.split("/");
        const importedLayer = segments[2] ?? "";
        const importedModule = (segments[3] ?? "").replace(/\.ts$/, "");
        const importedRank = LAYER_RANK[importedLayer];
        if (importedRank === undefined) {
          violations.push(
            `${file}: imports ${specifier} outside the layer directories`,
          );
          continue;
        }
        if (layerByModule.get(importedModule) !== importedLayer) {
          violations.push(
            `${file}: imports ${specifier} but the matrix places ${importedModule} in ${layerByModule.get(importedModule) ?? "(no row)"}`,
          );
        }
        if (importedRank > fileRank) {
          violations.push(
            `${file} (${fileLayer}, rank ${fileRank}) imports ${resolved} (${importedLayer}, rank ${importedRank}) — upward import`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
