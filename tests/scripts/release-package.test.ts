import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  currentSchemaReopenEvidence,
  RELEASE_PACKAGE_CAPS,
  validatePackResult,
} from "../../scripts/release-package";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("release package rehearsal", () => {
  // The full pack/install/init/reopen path runs exactly once in the release
  // implementation gate (`bun run release:package-rehearsal`). These tests
  // pin its allowlist and refusal policy without recursively running that
  // release gate from `bun test ./tests`.
  test("package.json names only the runtime allowlist", async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      readonly files?: ReadonlyArray<string>;
      readonly exports?: Readonly<Record<string, unknown>>;
    };
    expect(pkg.files).toEqual([
      "src/",
      "assets/extensions/",
      "assets/model-providers/",
      "assets/source-handlers/",
      "bin/dome",
      "README.md",
    ]);
    expect(Object.keys(pkg.exports ?? {})).toEqual([".", "./cli", "./mcp"]);
    expect(pkg.exports).not.toHaveProperty("./http");
  });

  test("artifact validation rejects development paths and oversized packs", () => {
    const requiredFiles = [
      { path: "README.md", size: 1, mode: 0o644 },
      { path: "package.json", size: 1, mode: 0o644 },
      { path: "bin/dome", size: 1, mode: 0o755 },
      { path: "assets/extensions/dome.markdown/manifest.yaml", size: 1, mode: 0o644 },
      { path: "assets/model-providers/anthropic.ts", size: 1, mode: 0o644 },
      { path: "assets/source-handlers/claude-slack.sh", size: 1, mode: 0o755 },
    ];
    const base = {
      filename: "dome-sdk.tgz",
      size: 6,
      unpackedSize: 6,
      entryCount: requiredFiles.length,
      files: requiredFiles,
    };
    expect(() => validatePackResult(base)).not.toThrow();
    expect(() => validatePackResult({
      ...base,
      entryCount: requiredFiles.length + 1,
      files: [...requiredFiles, { path: "tests/leak.test.ts", size: 1, mode: 0o644 }],
    })).toThrow("forbidden path");
    expect(() => validatePackResult({
      ...base,
      size: RELEASE_PACKAGE_CAPS.packedBytes + 1,
    })).toThrow("packed bytes");
  });

  test("current-schema evidence claims only successful opens and stable semantic refs", () => {
    const status = { head: "head-1", adopted: "adopted-1" };
    expect(currentSchemaReopenEvidence(status, status)).toEqual({
      attempts: 2,
      succeeded: true,
      semanticRefsStable: true,
      priorVersionUpgradeClaimed: false,
    });
    expect(() => currentSchemaReopenEvidence(
      status,
      { head: "head-2", adopted: "adopted-1" },
    )).toThrow("changed semantic refs");
    expect(() => currentSchemaReopenEvidence(
      { head: null, adopted: null },
      { head: null, adopted: null },
    )).toThrow("failed");
  });
});
