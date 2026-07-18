import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runPackedProductAcceptanceForTests,
  type PackedProductAcceptanceDependencies,
} from "../../scripts/packed-product-rehearsal";
import type { InstalledProductEvidence } from "../../src/product-package/installed-product";

describe("packed-product v2 rehearsal", () => {
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

  test("production adapter hardwires isolated global install, input retirement, and shipped verification", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "scripts", "packed-product-rehearsal.ts"), "utf8");
    for (const required of [
      "BUN_INSTALL_GLOBAL_DIR", "BUN_INSTALL_BIN", "BUN_INSTALL_CACHE_DIR",
      '"install", "-g", product.tarball', '"--production", "--ignore-scripts", "--backend=copyfile"',
      "rm(producer, { recursive: true })", "rm(productOutput, { recursive: true })", "rm(installCache, { recursive: true })",
      "rm(producerHome, { recursive: true, force: true })",
      "src\", \"product-package\", \"installed-product.ts", "HTTP_PROXY: \"http://127.0.0.1:1\"",
    ]) expect(source).toContain(required);
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
