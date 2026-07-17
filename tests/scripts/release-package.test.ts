import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  currentSchemaReopenEvidence,
  RELEASE_PACKAGE_CAPS,
  RELEASE_PACKAGE_NAME,
  validatePackResult,
  validateReleasePackageManifest,
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
      "contracts/agent-stream.ts",
      "contracts/capture.ts",
      "contracts/product-readiness.ts",
      "contracts/source-document.ts",
      "contracts/task-backlog.ts",
      "contracts/task-backlog-review.ts",
      "assets/extensions/",
      "assets/model-providers/",
      "assets/source-handlers/",
      "bin/dome",
      "LICENSE",
      "README.md",
    ]);
    expect(Object.keys(pkg.exports ?? {})).toEqual([".", "./cli", "./mcp"]);
    expect(pkg.exports).not.toHaveProperty("./http");
  });

  test("package.json carries the exact public identity and portable runtime contract", async () => {
    const [packageBody, license] = await Promise.all([
      readFile(join(REPO_ROOT, "package.json"), "utf8"),
      readFile(join(REPO_ROOT, "LICENSE"), "utf8"),
    ]);
    const pkg = JSON.parse(packageBody) as unknown;
    expect(RELEASE_PACKAGE_NAME).toBe("@marktoda/dome");
    expect(validateReleasePackageManifest(pkg)).toEqual([
      RELEASE_PACKAGE_NAME,
      `${RELEASE_PACKAGE_NAME}/cli`,
      `${RELEASE_PACKAGE_NAME}/mcp`,
    ]);
    expect(license).toStartWith("MIT License\n\nCopyright (c) 2026 Mark Toda\n");
    expect(license).toContain("Permission is hereby granted, free of charge");
    expect(pkg).not.toHaveProperty("os");
    expect(pkg).not.toHaveProperty("cpu");

    const record = pkg as Readonly<Record<string, unknown>>;
    expect(() => validateReleasePackageManifest({ ...record, name: "@example/dome" }))
      .toThrow("unexpected name");
    expect(() => validateReleasePackageManifest({
      ...record,
      bin: { dome: "bin/dome", extra: "bin/extra" },
    })).toThrow("unexpected bin");
    expect(() => validateReleasePackageManifest({
      ...record,
      exports: { ...(record.exports as object), "./http": "./src/http/server.ts" },
    })).toThrow("unexpected exports");
    for (const [field, value] of [
      ["engines", { bun: ">=1.2.13" }],
      ["packageManager", "bun@1.3.0"],
      ["type", "commonjs"],
      ["main", "src/cli/index.ts"],
      ["types", "src/cli/index.ts"],
    ] as const) {
      expect(() => validateReleasePackageManifest({ ...record, [field]: value }))
        .toThrow(`unexpected ${field}`);
    }
    expect(() => validateReleasePackageManifest({ ...record, os: ["darwin"] }))
      .toThrow("must not declare os");
    expect(() => validateReleasePackageManifest({ ...record, cpu: ["arm64"] }))
      .toThrow("must not declare cpu");
  });

  test("the PWA remains a private workspace package", async () => {
    const pkg = JSON.parse(
      await readFile(join(REPO_ROOT, "pwa", "package.json"), "utf8"),
    ) as { readonly name?: unknown; readonly private?: unknown };
    expect(pkg.name).toBe("@dome/pwa");
    expect(pkg.private).toBe(true);
  });

  test("every relative link in the shipped README resolves inside the artifact", async () => {
    const [readme, packageBody] = await Promise.all([
      readFile(join(REPO_ROOT, "README.md"), "utf8"),
      readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ]);
    const files = (JSON.parse(packageBody) as { readonly files: ReadonlyArray<string> }).files;
    const relativeTargets = [...readme.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1] ?? "")
      .filter((target) =>
        target !== "" &&
        !target.startsWith("#") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(target)
      )
      .map((target) => target.split(/[?#]/, 1)[0] ?? target);
    const excluded = relativeTargets.filter((target) =>
      target !== "package.json" &&
      !files.some((entry) => entry.endsWith("/") ? target.startsWith(entry) : target === entry)
    );
    expect(excluded).toEqual([]);
  });

  test("artifact validation rejects development paths and oversized packs", () => {
    const requiredFiles = [
      { path: "LICENSE", size: 1, mode: 0o644 },
      { path: "README.md", size: 1, mode: 0o644 },
      { path: "package.json", size: 1, mode: 0o644 },
      { path: "bin/dome", size: 1, mode: 0o755 },
      { path: "contracts/agent-stream.ts", size: 1, mode: 0o644 },
      { path: "contracts/capture.ts", size: 1, mode: 0o644 },
      { path: "contracts/product-readiness.ts", size: 1, mode: 0o644 },
      { path: "contracts/source-document.ts", size: 1, mode: 0o644 },
      { path: "contracts/task-backlog.ts", size: 1, mode: 0o644 },
      { path: "contracts/task-backlog-review.ts", size: 1, mode: 0o644 },
      { path: "assets/extensions/dome.markdown/manifest.yaml", size: 1, mode: 0o644 },
      { path: "assets/model-providers/anthropic.ts", size: 1, mode: 0o644 },
      { path: "assets/source-handlers/claude-slack.sh", size: 1, mode: 0o755 },
    ];
    const base = {
      filename: "marktoda-dome.tgz",
      size: 6,
      unpackedSize: 6,
      entryCount: requiredFiles.length,
      files: requiredFiles,
    };
    expect(() => validatePackResult(base)).not.toThrow();
    expect(() => validatePackResult({
      ...base,
      entryCount: requiredFiles.length - 1,
      files: requiredFiles.filter((file) => file.path !== "contracts/product-readiness.ts"),
    })).toThrow("missing runtime path: contracts/product-readiness.ts");
    expect(() => validatePackResult({
      ...base,
      entryCount: requiredFiles.length + 1,
      files: [...requiredFiles, { path: "tests/leak.test.ts", size: 1, mode: 0o644 }],
    })).toThrow("forbidden path");
    expect(() => validatePackResult({
      ...base,
      entryCount: requiredFiles.length + 1,
      files: [...requiredFiles, { path: "contracts/future.ts", size: 1, mode: 0o644 }],
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
