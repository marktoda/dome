import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { canonicalContentScopeSchema } from "../../src/core/content-scope";
import type { HomeArtifactVerificationEvidence } from "../../src/product-host/home-artifact";
import type { HomeSelectionDocument } from "../../src/product-host/home-selection";
import type { ReadOnlyInstalledProductEvidence } from "../../src/product-package/installed-product";
import {
  discoverGitVersion,
  discoverSetupInstalledHome,
  discoverSetupPrerequisites,
  discoverSetupProduct,
} from "../../src/setup/discovery";
import {
  DEFAULT_SETUP_CONTENT_SCOPE,
  renderSetupContentScopeConfig,
} from "../../src/setup/scaffold";

describe("setup discovery adapters", () => {
  test("the production product adapter depends only on the read-only package proof", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../src/setup/discovery.ts")).text();
    expect(source).toContain("verifyInstalledProductReadOnly");
    expect(source).not.toMatch(/\bverifyInstalledProduct\b(?!ReadOnly)/);
    expect(source).not.toContain("materializeHomeArtifactArchive");
  });

  test("normalizes locally observed prerequisite versions", async () => {
    const observed = await discoverSetupPrerequisites();
    expect(observed.bun).toMatch(/^\d+\.\d+\.\d+$/);
    expect(observed.git).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("does not misclassify a missing new vault as unavailable Home", async () => {
    const target = `/tmp/dome-setup-never-created-${crypto.randomUUID()}`;
    expect(await discoverSetupInstalledHome(target)).toEqual({
      state: "absent",
      artifactId: null,
      productVersion: null,
      buildCommit: null,
      manifestSha256: null,
      selectedVaultPath: null,
    });
  });

  test("closes installed Home identity across selector, upgrade, and artifact evidence", async () => {
    const target = resolve("/tmp/dome-setup-owned-vault");
    const artifactId = "a".repeat(64);
    const selector = selectionDocument("", {
      schema: "dome.home.installation/v1",
      vault: target,
      artifact: { id: artifactId, version: "0.4.0" },
      environment: [],
    });
    let captures = 0;
    const result = await discoverSetupInstalledHome(target, {
      operations: {
        captureSelection: async (path) => {
          captures += 1;
          return Object.freeze({ ...selector, path });
        },
        inspectUpgrade: async () => upgradeState("inactive"),
        verifyArtifact: async () => artifactEvidence(artifactId, "0.4.0"),
      },
    });
    expect(captures).toBe(2);
    expect(result).toEqual({
      state: "owned",
      artifactId,
      productVersion: "0.4.0",
      buildCommit: "b".repeat(40),
      manifestSha256: "c".repeat(64),
      selectedVaultPath: target,
    });
  });

  test("fails closed for active upgrades, malformed selectors, artifact mismatch, and selector races", async () => {
    const target = resolve("/tmp/dome-setup-ambiguous-vault");
    const artifactId = "a".repeat(64);
    const valid = selectionDocument("", {
      schema: "dome.home.installation/v1",
      vault: target,
      artifact: { id: artifactId, version: "0.4.0" },
      environment: [],
    });
    const discover = async (input: Readonly<{
      selector?: HomeSelectionDocument;
      upgrade?: "inactive" | "active" | "recovery-required" | "unavailable";
      artifactId?: string;
      race?: boolean;
    }> = {}) => {
      let captures = 0;
      return await discoverSetupInstalledHome(target, {
        operations: {
          captureSelection: async (path) => {
            captures += 1;
            const selected = input.selector ?? valid;
            return Object.freeze({
              ...selected,
              path,
              ...(input.race && captures === 2 ? { bytes: `${selected.bytes} ` } : {}),
            });
          },
          inspectUpgrade: async () => upgradeState(input.upgrade ?? "inactive"),
          verifyArtifact: async () => artifactEvidence(input.artifactId ?? artifactId, "0.4.0"),
        },
      });
    };
    for (const state of ["active", "recovery-required"] as const) {
      expect((await discover({ upgrade: state })).state).toBe("upgrade-active");
    }
    expect((await discover({ upgrade: "unavailable" })).state).toBe("ambiguous");
    expect((await discover({ selector: selectionDocument("", { malformed: true }) })).state).toBe("ambiguous");
    expect((await discover({ artifactId: "d".repeat(64) })).state).toBe("ambiguous");
    expect((await discover({ race: true })).state).toBe("ambiguous");
    expect((await discoverSetupInstalledHome(target, {
      operations: { captureSelection: async () => { throw new Error("redirected"); } },
    })).state).toBe("ambiguous");
  });

  test("classifies a stable valid selector for a different vault as foreign ownership", async () => {
    const target = resolve("/tmp/dome-setup-owner-target");
    const foreign = resolve("/tmp/dome-setup-other-owner");
    const artifactId = "a".repeat(64);
    const selector = selectionDocument("", {
      schema: "dome.home.installation/v1",
      vault: foreign,
      artifact: { id: artifactId, version: "0.4.0" },
      environment: [],
    });
    let captures = 0;
    const result = await discoverSetupInstalledHome(target, {
      operations: {
        captureSelection: async (path) => {
          captures += 1;
          return Object.freeze({ ...selector, path });
        },
        inspectUpgrade: async () => { throw new Error("must not inspect a foreign owner's upgrade"); },
        verifyArtifact: async () => { throw new Error("must not verify a foreign owner's artifact"); },
      },
    });
    expect(captures).toBe(2);
    expect(result).toEqual({
      state: "foreign-owner",
      artifactId,
      productVersion: "0.4.0",
      buildCommit: null,
      manifestSha256: null,
      selectedVaultPath: foreign,
    });
  });

  test("projects only evidence returned by the installed-product verifier", async () => {
    const sha = "a".repeat(64);
    const commit = "b".repeat(40);
    const homePath = "product/home/dome-home-0.4.0-darwin-arm64.tar.gz";
    const files = [
      { path: "LICENSE", bytes: 1, sha256: sha, mode: "0644" },
      { path: "README.md", bytes: 1, sha256: sha, mode: "0644" },
      { path: "bin/dome", bytes: 1, sha256: sha, mode: "0755" },
      { path: "package.json", bytes: 1, sha256: sha, mode: "0644" },
      { path: homePath, bytes: 1, sha256: sha, mode: "0644" },
      { path: "product/pwa/index.html", bytes: 1, sha256: sha, mode: "0644" },
      { path: "src/index.ts", bytes: 1, sha256: sha, mode: "0644" },
    ];
    const manifest = {
      schema: "dome.product-package/v1",
      package: { name: "@marktoda/dome", version: "0.4.0", sourceCommit: commit },
      platform: { os: "darwin", arch: "arm64" },
      home: {
        path: homePath, bytes: 1, sha256: sha, root: "dome-home-0.4.0-darwin-arm64",
        manifestSha256: sha, artifactId: sha, productVersion: "0.4.0", buildCommit: commit,
      },
      pwa: { root: "product/pwa", entries: [files[5]] },
      files,
    } as ReadOnlyInstalledProductEvidence["manifest"];
    const verified: ReadOnlyInstalledProductEvidence = {
      manifest,
      manifestSha256: "c".repeat(64),
      filesVerified: files.length,
      pwaFilesVerified: 1,
      declaredHome: { artifactId: sha, archiveSha256: sha, manifestSha256: sha, buildCommit: commit },
    };

    const product = await discoverSetupProduct("/installed/dome", async ({ packageRoot }) => {
      expect(packageRoot).toBe("/installed/dome");
      return verified;
    });
    expect(product.packageName).toBe("@marktoda/dome");
    expect(product.packagedHome.artifactId).toBe(sha);
    expect(product.productManifestSha256).toBe("c".repeat(64));
    expect(product.productManifestSha256).not.toBe(sha);
  });

  test("bounds Git probe lifetime and output before parsing a version", async () => {
    expect(await discoverGitVersion({
      command: ["bun", "-e", "process.stdout.write('git version 2.50.1\\n')"],
      timeoutMs: 1_000,
    })).toBe("2.50.1");

    await expect(discoverGitVersion({
      command: ["bun", "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
    })).rejects.toThrow("timed out");
    await expect(discoverGitVersion({
      command: ["bun", "-e", "process.stdout.write('x'.repeat(2048))"],
      timeoutMs: 1_000,
    })).rejects.toThrow("exceeded 1024 bytes");
  });

  test("renders the exact proposed scope into the planned config bytes", () => {
    const body = renderSetupContentScopeConfig(DEFAULT_SETUP_CONTENT_SCOPE);
    expect(body).toContain("content_scope:\n  version: 1");
    expect(body).toContain('    - "**/*.md"');
    expect(body).toContain('    - ".dome/**"\n    - ".git/**"');
    const config = parseYaml(body) as Record<string, unknown>;
    expect(canonicalContentScopeSchema.parse(config.content_scope)).toEqual(DEFAULT_SETUP_CONTENT_SCOPE);

    expect(() => renderSetupContentScopeConfig({
      ...DEFAULT_SETUP_CONTENT_SCOPE,
      include: ["notes/**/*.md", "**/*.md"],
    })).toThrow("must be sorted and unique");
  });
});

function selectionDocument(path: string, value: unknown): HomeSelectionDocument {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  return Object.freeze({
    path,
    bytes,
    mode: 0o600,
    size: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function artifactEvidence(artifactId: string, productVersion: string): HomeArtifactVerificationEvidence {
  return {
    manifest: {
      artifact: { id: artifactId },
      product: { version: productVersion },
      build: { gitCommit: "b".repeat(40) },
    } as HomeArtifactVerificationEvidence["manifest"],
    manifestSha256: "c".repeat(64),
  };
}

function upgradeState(state: "inactive" | "active" | "recovery-required" | "unavailable") {
  return {
    state,
    candidate: null,
    operationId: null,
    outcome: null,
    nextAction: state === "unavailable" ? "inspect-home-status" as const :
      state === "inactive" ? "none" as const : "retry-recovery" as const,
  };
}
