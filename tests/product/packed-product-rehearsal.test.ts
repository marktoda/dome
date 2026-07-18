import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildPackedProductGlobalInstallCommand,
  PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT,
  packedProductGlobalInstallLayout,
  runPackedProductAcceptanceForTests,
  type PackedProductAcceptanceDependencies,
} from "../../scripts/packed-product-rehearsal";
import type { InstalledProductEvidence } from "../../src/product-package/installed-product";
import { formatReleaseProgress, runReleasePhase } from "../../scripts/release-progress";

describe("packed-product v3 rehearsal", () => {
  test("portable orchestration retires every producer input before installed checks and cannot issue evidence", async () => {
    const events: string[] = [];
    const report = await runPackedProductAcceptanceForTests(dependencies(events));
    expect(events).toEqual(["install", "retire", "assert-unavailable", "product", "exports", "cli", "consumer"]);
    expect(report).toMatchObject({
      evidence: false,
      repositoryUnavailable: true,
      exports: ["@marktoda/dome", "@marktoda/dome/cli", "@marktoda/dome/mcp"],
      cliHelp: true,
    });
  });

  test("retirement failure prevents every installed-product claim", async () => {
    const events: string[] = [];
    const base = dependencies(events);
    await expect(runPackedProductAcceptanceForTests({
      ...base,
      retireInputs: async () => { events.push("retire"); throw new Error("producer retained"); },
    })).rejects.toThrow("producer retained");
    expect(events).toEqual(["install", "retire"]);
  });

  test("global installation is npm-owned until Bun preserves the packed executable mode", () => {
    expect(PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT).toEqual({
      installer: "npm",
      runtime: "bun",
      isolatedPrefix: true,
      isolatedCache: true,
      productionOnly: true,
      lifecycleScripts: false,
      binTargetMode: "0755",
    });
    expect(buildPackedProductGlobalInstallCommand({
      npmExecutable: "/trusted/bin/npm",
      tarball: "/private/product/marktoda-dome-0.4.0.tgz",
      prefix: "/private/install",
      cache: "/private/cache",
    })).toEqual([
      "/trusted/bin/npm", "install", "--global",
      "/private/product/marktoda-dome-0.4.0.tgz",
      "--prefix", "/private/install",
      "--cache", "/private/cache",
      "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
      "--registry=https://registry.npmjs.org",
    ]);
    expect(() => buildPackedProductGlobalInstallCommand({
      npmExecutable: "/trusted/bin/bun",
      tarball: "/private/product/marktoda-dome-0.4.0.tgz",
      prefix: "/private/install",
      cache: "/private/cache",
    })).toThrow("packed-product global install paths are invalid");
    expect(packedProductGlobalInstallLayout("/private/install")).toEqual({
      modulesRoot: "/private/install/lib/node_modules",
      packageRoot: "/private/install/lib/node_modules/@marktoda/dome",
      binRoot: "/private/install/bin",
      domeBin: "/private/install/bin/dome",
    });
  });

  test("production adapter hardwires input retirement and shipped verification", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "scripts", "packed-product-rehearsal.ts"), "utf8");
    for (const required of [
      "buildPackedProductGlobalInstallCommand", "assertGlobalInstallLinks",
      'removeOwnedDirectory(producer, "producer repository")',
      'removeOwnedDirectory(productOutput, "product build output")',
      'removeOwnedDirectory(installCache, "npm install cache")',
      'removeOwnedDirectory(producerHome, "producer home and XDG state")',
      "src\", \"product-package\", \"installed-product.ts", "HTTP_PROXY: \"http://127.0.0.1:1\"",
    ]) expect(source).toContain(required);
  });

  test("release phases expose only bounded content-free progress and preserve operation failures", async () => {
    const events: Array<Readonly<{ phase: string; state: string; elapsedMs: number }>> = [];
    const value = await runReleasePhase("installed-chromium-acceptance", (event) => { events.push(event); }, async () => 42);
    expect(value).toBe(42);
    expect(events.map(({ phase, state }) => ({ phase, state }))).toEqual([
      { phase: "installed-chromium-acceptance", state: "started" },
      { phase: "installed-chromium-acceptance", state: "completed" },
    ]);
    for (const event of events) {
      expect(formatReleaseProgress(event as Parameters<typeof formatReleaseProgress>[0]))
        .toMatch(/^packed-product-rehearsal: phase=[a-z0-9-]+ state=(?:started|completed|failed) elapsed_ms=\d+$/);
    }

    const primary = new Error("primary release failure");
    await expect(runReleasePhase("verify-consumer", () => { throw new Error("reporter failure"); }, async () => {
      throw primary;
    })).rejects.toBe(primary);
    expect(await runReleasePhase("verify-cli", () => { throw new Error("reporter failure"); }, async () => "ok"))
      .toBe("ok");
    await expect(runReleasePhase("OWNER/path", undefined, async () => "unreachable"))
      .rejects.toThrow("release progress phase is invalid");
    await expect(runReleasePhase("a".repeat(129), undefined, async () => "unreachable"))
      .rejects.toThrow("release progress phase is invalid");
    expect(() => formatReleaseProgress({
      phase: "verify-cli", state: "forged", elapsedMs: 0,
    } as never)).toThrow("release progress state is invalid");
  });

  test("async reporter rejection is observed for every state without changing the release outcome", async () => {
    const unhandled: unknown[] = [];
    const reported: string[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const reporter = async ({ state }: { readonly state: string }): Promise<void> => {
        reported.push(state);
        throw new Error(`async reporter ${state}`);
      };
      expect(await runReleasePhase("verify-cli", reporter, async () => "ok")).toBe("ok");
      const primary = new Error("primary release failure");
      await expect(runReleasePhase("verify-consumer", reporter, async () => {
        throw primary;
      })).rejects.toBe(primary);
      await Bun.sleep(0);
      expect(reported).toEqual(["started", "completed", "started", "failed"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

function dependencies(events: string[]): PackedProductAcceptanceDependencies {
  const product = {
    manifest: { package: { sourceCommit: "1".repeat(40) } },
    manifestSha256: "a".repeat(64),
    filesVerified: 1,
    pwaFilesVerified: 1,
    home: { artifactId: "b".repeat(64), archiveSha256: "c".repeat(64), manifestSha256: "d".repeat(64), buildCommit: "1".repeat(40) },
  } as unknown as InstalledProductEvidence;
  return Object.freeze({
    install: async () => { events.push("install"); },
    retireInputs: async () => { events.push("retire"); },
    assertInputsUnavailable: async () => { events.push("assert-unavailable"); },
    verifyInstalled: async () => { events.push("product"); return product; },
    verifyExports: async () => { events.push("exports"); return ["@marktoda/dome", "@marktoda/dome/cli", "@marktoda/dome/mcp"]; },
    verifyCli: async () => { events.push("cli"); },
    verifyConsumer: async () => {
      events.push("consumer");
      return Object.freeze({
        scaffold: Object.freeze({ modelProvider: "anthropic" as const, source: "slack" as const, bundlesResolved: true as const }),
        currentSchemaReopen: Object.freeze({
          attempts: 2 as const, succeeded: true as const, semanticRefsStable: true as const, priorVersionUpgradeClaimed: false as const,
        }),
      });
    },
  });
}
