import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_BETA_STEP_KEYS,
  HomeBetaEvidenceError,
  aggregateHomeBetaEvidence as aggregateHomeBetaEvidenceCore,
  homeBetaEvidenceSchema,
  readHomeBetaPacketForTests,
  validateHomeBetaEvidence as validateHomeBetaEvidenceCore,
  type HomeBetaEvidence,
} from "../../scripts/home-beta-evidence";

const RECEIPT = "a".repeat(64);
const VERSION = "0.3.0";
const validateHomeBetaEvidence = (raw: unknown, receipt = RECEIPT) =>
  validateHomeBetaEvidenceCore(raw, receipt, VERSION);
const aggregateHomeBetaEvidence = (
  raw: ReadonlyArray<unknown>,
  receipt = RECEIPT,
  operatorReviewed = true,
) => aggregateHomeBetaEvidenceCore(raw, receipt, VERSION, operatorReviewed);

describe("Home owner-beta evidence schema", () => {
  test("accepts a qualifying packet and derives qualification", () => {
    const validation = validateHomeBetaEvidence(packet(1), RECEIPT);
    expect(validation).toMatchObject({ status: "valid", qualified: true });
    expect(validation.nonqualificationReasons).toEqual([]);
    expect(JSON.stringify(validation)).not.toContain('"date":');
    expect(JSON.stringify(validation)).not.toContain("chromiumMajor");
  });

  test("keeps failed, not-run, and false-attestation packets valid but nonqualifying", () => {
    const input = packet(1);
    input.attestations.consented = false;
    input.steps.install = failed(7);
    input.observations.captures.online["start-to-local"] = failed(8);
    input.observations.captures.online["start-to-commit"] = notRun();
    input.observations.captures.online["start-to-adopt"] = notRun();
    input.observations.mutationQueue = {
      scheduled: 1, success: 0, timeout: 0, failed: 0, notRun: 1,
      saturationEvents: 1, conflictEvents: 1, retryAttempts: 1,
    };
    input.observations.device["phone-pair"] = notRun();
    input.observations.recovery.restore = failed(9);
    input.observations.platform.ios.accessibility = notRun();
    input.observations.cost.model = { source: "unavailable", microUsd: null };
    input.observations.cost.transcription = { source: "unavailable", microUsd: null };

    const validation = validateHomeBetaEvidence(input, RECEIPT);
    expect(validation.status).toBe("valid");
    expect(validation.qualified).toBe(false);
    expect(validation.nonqualificationReasons).toEqual(expect.arrayContaining([
      "consent-not-attested",
      "journey-step-not-ok",
      "capture-not-ok",
      "mutation-queue-not-ok",
      "device-outcome-not-ok",
      "recovery-outcome-not-ok",
      "platform-outcome-not-ok",
      "model-cost-not-measured",
      "transcription-cost-unavailable",
    ]));
  });

  test("requires measured model cost while allowing unused transcription", () => {
    const input = packet(1);
    input.observations.cost.model = { source: "not-used", microUsd: 0 };
    const validation = validateHomeBetaEvidence(input);
    expect(validation.qualified).toBe(false);
    expect(validation.nonqualificationReasons).toContain("model-cost-not-measured");
    expect(validation.nonqualificationReasons).not.toContain("transcription-cost-unavailable");
  });

  test("rejects unknown, missing, wrong-number, invalid-union, and wrong-cardinality shapes", () => {
    const cases: unknown[] = [];
    cases.push({ ...packet(1), secretPath: "/private/vault/owner.md" });
    const missing = packet(1) as Record<string, unknown>;
    delete missing.protocol;
    cases.push(missing);
    const wrongNumber = packet(1);
    (wrongNumber.observations.installToPairedAsk as unknown as { durationMs: unknown }).durationMs = "1";
    cases.push(wrongNumber);
    const invalidUnion = packet(1);
    (invalidUnion.steps.install as unknown as { outcome: string }).outcome = "skipped";
    cases.push(invalidUnion);
    const invalidNotRun = packet(1);
    const invalidNotRunOutcome = invalidNotRun.steps.install as unknown as {
      outcome: string;
      durationMs: number | null;
    };
    invalidNotRunOutcome.outcome = "not-run";
    invalidNotRunOutcome.durationMs = 1;
    cases.push(invalidNotRun);
    const wrongCardinality = packet(1);
    wrongCardinality.observations.todayDuringGeneration.pop();
    cases.push(wrongCardinality);
    const invalidSemver = packet(1);
    invalidSemver.product.version = "v0.3.0";
    cases.push(invalidSemver);

    for (const candidate of cases) {
      expect(() => validateHomeBetaEvidence(candidate, RECEIPT)).toThrow(HomeBetaEvidenceError);
    }
  });

  test("enforces monotonic capture clocks, bounded integers, and queue count partition", () => {
    const nonmonotonic = packet(1);
    nonmonotonic.observations.captures.online["start-to-local"] = ok(3);
    nonmonotonic.observations.captures.online["start-to-commit"] = ok(2);
    expect(homeBetaEvidenceSchema.safeParse(nonmonotonic).success).toBe(false);

    const wrongTimeoutBudget = packet(1);
    wrongTimeoutBudget.observations.captures.online["start-to-local"] = ok(3);
    wrongTimeoutBudget.observations.captures.online["start-to-commit"] = {
      outcome: "timeout", durationMs: 2,
    };
    wrongTimeoutBudget.observations.captures.online["start-to-adopt"] = notRun();
    expect(homeBetaEvidenceSchema.safeParse(wrongTimeoutBudget).success).toBe(false);

    const durationOverflow = packet(1);
    durationOverflow.steps.install = ok(900_001);
    expect(homeBetaEvidenceSchema.safeParse(durationOverflow).success).toBe(false);

    const countOverflow = packet(1);
    countOverflow.observations.mutationQueue.retryAttempts = 1_000_001;
    expect(homeBetaEvidenceSchema.safeParse(countOverflow).success).toBe(false);

    const costOverflow = packet(1);
    costOverflow.observations.cost.model = { source: "run-ledger", microUsd: 1_000_000_001 };
    expect(homeBetaEvidenceSchema.safeParse(costOverflow).success).toBe(false);

    const invalidPartition = packet(1);
    invalidPartition.observations.mutationQueue.success = 2;
    expect(homeBetaEvidenceSchema.safeParse(invalidPartition).success).toBe(false);

    const zeroQueue = packet(1);
    zeroQueue.observations.mutationQueue = {
      scheduled: 0, success: 0, timeout: 0, failed: 0, notRun: 0,
      saturationEvents: 0, conflictEvents: 0, retryAttempts: 0,
    };
    expect(validateHomeBetaEvidence(zeroQueue, RECEIPT).nonqualificationReasons)
      .toContain("mutation-queue-not-ok");
  });

  test("requires exact trusted receipt and product version without SemVer normalization", () => {
    expect(() => validateHomeBetaEvidence(packet(1), "b".repeat(64))).toThrow("release-mismatch");
    const prerelease = packet(1);
    prerelease.product.version = "0.3.0-beta.1+public.2";
    expect(validateHomeBetaEvidenceCore(
      prerelease, RECEIPT, "0.3.0-beta.1+public.2",
    ).productVersion).toBe("0.3.0-beta.1+public.2");
    for (const ownerVersion of ["0.3.0-beta.1", "0.3.0+owner-build"]) {
      const input = packet(1);
      input.product.version = ownerVersion;
      expect(() => validateHomeBetaEvidenceCore(input, RECEIPT, VERSION))
        .toThrow("version-mismatch");
    }
    expect(() => validateHomeBetaEvidenceCore(packet(1), RECEIPT, "v0.3.0"))
      .toThrow("version-mismatch");
  });

  test("requires a coarse platform major only when that platform ran", () => {
    const omittedIos = packet(1);
    omittedIos.environment.iosMajor = null;
    for (const key of ["install", "offline", "update", "accessibility"] as const) {
      omittedIos.observations.platform.ios[key] = notRun();
    }
    expect(() => validateHomeBetaEvidence(omittedIos, RECEIPT)).not.toThrow();

    const fabricatedContext = packet(1);
    fabricatedContext.environment.iosMajor = null;
    expect(() => validateHomeBetaEvidence(fabricatedContext, RECEIPT)).toThrow("invalid-packet");
  });
});

describe("Home owner-beta aggregation", () => {
  test("requires explicit out-of-band operator review after every packet qualifies", () => {
    const pending = aggregateHomeBetaEvidenceCore(packetSet(), RECEIPT, VERSION, false);
    expect(pending.status).toBe("review-required");
    expect(pending.blockers).toEqual(["operator-review-required"]);
    expect(pending.manualReview).toEqual({
      status: "required",
      checks: ["owner-truth-consent-and-external-owner", "five-distinct-owners"],
    });

    const reviewed = aggregateHomeBetaEvidenceCore(packetSet(), RECEIPT, VERSION, true);
    expect(reviewed.status).toBe("ready");
    expect(reviewed.blockers).toEqual([]);
    expect(reviewed.manualReview.status).toBe("completed");
  });

  test("requires five explicit packets, retains denominators, and uses nearest-rank P95", () => {
    expect(() => aggregateHomeBetaEvidence(packetSet().slice(0, 4), RECEIPT)).toThrow("input-count");
    const report = aggregateHomeBetaEvidence(packetSet(), RECEIPT);
    expect(report.status).toBe("ready");
    expect(report.packets).toEqual({ total: 5, qualified: { numerator: 5, denominator: 5 } });
    expect(report.measures.todayDuringGeneration).toMatchObject({
      attempted: 100,
      success: 100,
      successRate: { numerator: 100, denominator: 100 },
      successfulP95Ms: 514,
      maxObservedOwnerSuccessfulP95Ms: 518,
      maxObservedOwnerP95Label: "low-sample-no-population-claim",
    });
    expect(report.measures.capture.startToAdopt.attempted).toBe(10);
    expect(report.measures.mutationQueue).toMatchObject({
      scheduled: 15,
      success: 15,
      saturationEvents: 5,
      conflictEvents: 5,
      retryAttempts: 5,
    });
    expect(report.blockers).toEqual([]);
  });

  test("is order independent and rejects canonical-identical packets", () => {
    const packets = packetSet();
    expect(aggregateHomeBetaEvidence([...packets].reverse(), RECEIPT))
      .toEqual(aggregateHomeBetaEvidence(packets, RECEIPT));
    expect(() => aggregateHomeBetaEvidence([
      packets[0], packets[1], packets[2], packets[3], structuredClone(packets[0]),
    ], RECEIPT)).toThrow("duplicate-packet");
  });

  test("retains failure denominators and refuses to hide one failure behind five successes", () => {
    const failedPacket = packet(6);
    failedPacket.steps.install = failed(10);
    failedPacket.observations.todayDuringGeneration[0] = {
      outcome: "timeout", durationMs: 30_000,
    };
    failedPacket.observations.sourceDuringGeneration[0] = notRun();
    const report = aggregateHomeBetaEvidence([...packetSet(), failedPacket], RECEIPT);
    expect(report.status).toBe("not-ready");
    expect(report.packets.qualified).toEqual({ numerator: 5, denominator: 6 });
    expect(report.steps.install).toMatchObject({ attempted: 6, success: 5, failed: 1 });
    expect(report.measures.todayDuringGeneration).toMatchObject({
      attempted: 120, success: 119, timeout: 1,
    });
    expect(report.measures.sourceDuringGeneration).toMatchObject({
      attempted: 119, success: 119, "not-run": 1,
      successRate: { numerator: 119, denominator: 120 },
    });
    expect(report.nonqualificationReasons["journey-step-not-ok"]).toBe(1);
    expect(report.nonqualificationReasons["scheduled-observation-not-ok"]).toBe(1);
    expect(report.blockers).toEqual(["one-or-more-nonqualifying-packets"]);
  });

  test("uses one closed aggregate blocker whenever any submitted packet does not qualify", () => {
    const packets = packetSet();
    packets[0]!.steps.install = failed(10);
    const report = aggregateHomeBetaEvidence(packets, RECEIPT);
    expect(report.status).toBe("not-ready");
    expect(report.packets.qualified).toEqual({ numerator: 4, denominator: 5 });
    expect(report.blockers).toEqual(["one-or-more-nonqualifying-packets"]);
    expect(report.nonqualificationReasons["journey-step-not-ok"]).toBe(1);
  });

  test("accepts at most one hundred explicit packets", () => {
    const packets = Array.from({ length: 100 }, (_, index) => packet(index + 1));
    expect(aggregateHomeBetaEvidence(packets, RECEIPT).packets.total).toBe(100);
    expect(() => aggregateHomeBetaEvidence([...packets, packet(101)], RECEIPT))
      .toThrow("input-count");
  });

  test("emits only aggregate-safe dimensions", () => {
    const serialized = JSON.stringify(aggregateHomeBetaEvidence(packetSet(), RECEIPT));
    for (const forbidden of [
      '"date":', "macosMajor", "iosMajor", "chromiumMajor", "packet.json",
      "/private/", "owner.md", "deviceId", "providerName", "modelName",
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain(RECEIPT);
  });
});

describe("Home owner-beta CLI boundary", () => {
  test("prints JSON on success and changes exit only for require-ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-beta-cli-test-"));
    try {
      const paths: string[] = [];
      for (const [index, input] of packetSet().entries()) {
        const path = join(root, `${index}.json`);
        await writeFile(path, JSON.stringify(input));
        paths.push(path);
      }
      const validate = await runCli([
        "validate", "--input", paths[0]!, "--expected-receipt", RECEIPT,
      ]);
      expect(validate.exitCode).toBe(0);
      expect(JSON.parse(validate.stdout)).toMatchObject({ status: "valid", qualified: true });
      expect(validate.stderr).toBe("");
      const missingVersion = await runCli([
        "validate", "--input", paths[0]!, "--expected-receipt", RECEIPT,
      ], false);
      expect(missingVersion.exitCode).toBe(64);
      expect(JSON.parse(missingVersion.stdout).error).toBe("usage");

      const aggregateArgs = paths.flatMap((path) => ["--input", path]);
      const pendingReview = await runCli([
        "aggregate", ...aggregateArgs, "--expected-receipt", RECEIPT, "--require-ready",
      ]);
      expect(pendingReview.exitCode).toBe(1);
      expect(JSON.parse(pendingReview.stdout).status).toBe("review-required");
      const ready = await runCli([
        "aggregate", ...aggregateArgs, "--expected-receipt", RECEIPT,
        "--operator-reviewed", "--require-ready",
      ]);
      expect(ready.exitCode).toBe(0);
      expect(JSON.parse(ready.stdout).status).toBe("ready");
      expect(ready.stdout).not.toContain(root);

      const failedPacket = packet(1);
      failedPacket.steps.install = failed(10);
      await writeFile(paths[0]!, JSON.stringify(failedPacket));
      const advisory = await runCli([
        "aggregate", ...aggregateArgs, "--expected-receipt", RECEIPT,
      ]);
      expect(advisory.exitCode).toBe(0);
      expect(JSON.parse(advisory.stdout).status).toBe("not-ready");
      const required = await runCli([
        "aggregate", ...aggregateArgs, "--expected-receipt", RECEIPT,
        "--operator-reviewed", "--require-ready",
      ]);
      expect(required.exitCode).toBe(1);
      expect(JSON.parse(required.stdout).blockers)
        .toEqual(["one-or-more-nonqualifying-packets"]);
      expect(JSON.parse(required.stdout).manualReview.status).toBe("completed");

      const duplicateReviewFlag = await runCli([
        "aggregate", ...aggregateArgs, "--expected-receipt", RECEIPT,
        "--operator-reviewed", "--operator-reviewed",
      ]);
      expect(duplicateReviewFlag.exitCode).toBe(64);
      expect(JSON.parse(duplicateReviewFlag.stdout).error).toBe("usage");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinks, oversized files, non-files, and invalid JSON with fixed safe errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-beta-evidence-test-"));
    try {
      const valid = join(root, "valid.json");
      const link = join(root, "link.json");
      const oversized = join(root, "oversized.json");
      const invalid = join(root, "invalid.json");
      const directory = join(root, "directory");
      await writeFile(valid, JSON.stringify(packet(1)));
      await symlink(valid, link);
      await writeFile(oversized, " ".repeat(64 * 1024 + 1));
      await writeFile(invalid, "{not-json");
      await mkdir(directory);

      expect(await cliError(link)).toBe("input-not-direct");
      expect(await cliError(oversized)).toBe("input-too-large");
      expect(await cliError(directory)).toBe("input-not-direct");
      expect(await cliError(invalid)).toBe("invalid-json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects evidence that changes through the held file while it is read", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-beta-stability-test-"));
    try {
      const path = join(root, "packet.json");
      await writeFile(path, JSON.stringify(packet(1)));
      await expect(readHomeBetaPacketForTests(path, async () => {
        await appendFile(path, " ");
      })).rejects.toThrow("input-unstable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never reflects injected forbidden material or input paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-beta-private-owner-name-"));
    try {
      const path = join(root, "secret-vault-packet.json");
      await writeFile(path, JSON.stringify({ ...packet(1), notes: "credential secret owner.md" }));
      const result = await runCli(["validate", "--input", path, "--expected-receipt", RECEIPT]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        schema: "dome.home.beta-command/v1", status: "error", error: "invalid-packet",
      });
      expect(result.stdout).not.toContain(root);
      expect(result.stdout).not.toContain("credential");
      expect(result.stderr).toBe("");

      const mismatched = packet(1);
      mismatched.product.version = "0.3.0+private-owner-build";
      await writeFile(path, JSON.stringify(mismatched));
      const mismatch = await runCli([
        "validate", "--input", path, "--expected-receipt", RECEIPT,
      ]);
      expect(JSON.parse(mismatch.stdout).error).toBe("version-mismatch");
      expect(mismatch.stdout).not.toContain("private-owner-build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("has no production caller or product/network/database/process dependency", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "scripts", "home-beta-evidence.ts"), "utf8");
    expect(source.match(/^import .*;$/gm)).toEqual([
      'import { constants } from "node:fs";',
      'import { lstat, open } from "node:fs/promises";',
      'import { valid as validSemver } from "semver";',
      'import { z } from "zod";',
    ]);
    for (const forbidden of [
      /from ["'][^"']*src\//,
      /\bfetch\s*\(/,
      /\bBun\.spawn\b/,
      /\bDatabase\b/,
      /\bopenVault\b/,
      /\bsqlite\b/i,
    ]) expect(source).not.toMatch(forbidden);

    const repoRoot = join(import.meta.dir, "..", "..");
    const productionReferences: string[] = [];
    for (const root of ["src", "bin", "pwa", "assets", "contracts", "scripts"]) {
      for await (const path of new Bun.Glob(`${root}/**/*`).scan({ cwd: repoRoot })) {
        if (path === "scripts/home-beta-evidence.ts" || path.includes("/node_modules/")) continue;
        const absolute = join(repoRoot, path);
        if (!(await stat(absolute)).isFile()) continue;
        if ((await readFile(absolute, "utf8")).includes("home-beta-evidence")) {
          productionReferences.push(path);
        }
      }
    }
    expect(productionReferences).toEqual([]);
    expect(await readFile(join(repoRoot, "package.json"), "utf8"))
      .not.toContain("home-beta-evidence");
  });

  test("keeps the runbook's closed packet example schema-valid", async () => {
    const runbook = await readFile(join(
      import.meta.dir, "..", "..", "docs", "cohesive", "runbooks",
      "2026-07-home-pwa-acceptance.md",
    ), "utf8");
    const section = runbook.slice(runbook.indexOf("## P6 local owner-beta packet"));
    const json = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(json).toBeDefined();
    expect(() => validateHomeBetaEvidence(JSON.parse(json!), RECEIPT)).not.toThrow();
  });
});

function packetSet(): ReturnType<typeof packet>[] {
  return [1, 2, 3, 4, 5].map(packet);
}

function packet(seed: number): HomeBetaEvidence {
  const steps = Object.fromEntries(HOME_BETA_STEP_KEYS.map((key) => [key, ok(seed)]));
  const timedRecord = <Keys extends readonly string[]>(keys: Keys) => Object.fromEntries(
    keys.map((key) => [key, ok(seed)]),
  ) as Record<Keys[number], ReturnType<typeof ok>>;
  return homeBetaEvidenceSchema.parse({
    schema: "dome.home.beta-evidence/v1" as const,
    protocol: "dome.home.beta-protocol/2026-07-15.1" as const,
    product: {
      version: "0.3.0",
      target: "darwin-arm64" as const,
      distributionReceiptSha256: RECEIPT,
    },
    environment: { date: "2026-07-15", macosMajor: 15, iosMajor: 18, chromiumMajor: 138 },
    attestations: { consented: true, externalOwner: true, withoutDeveloperIntervention: true },
    steps,
    observations: {
      installToPairedAsk: ok(seed),
      todayDuringGeneration: Array.from({ length: 20 }, (_, index) => ok(seed * 100 + index)),
      sourceDuringGeneration: Array.from({ length: 20 }, (_, index) => ok(seed * 100 + index)),
      captures: {
        online: capture(seed),
        "offline-replay": capture(seed + 3),
      },
      restart: timedRecord(["mid-operation-reconcile"] as const),
      readiness: timedRecord(["initial", "after-restart", "after-restore"] as const),
      mutationQueue: {
        scheduled: 3, success: 3, timeout: 0, failed: 0, notRun: 0,
        saturationEvents: 1, conflictEvents: 1, retryAttempts: 1,
      },
      device: timedRecord([
        "desktop-pair", "phone-pair", "phone-revoke", "revoked-unauthorized", "desktop-authorized",
      ] as const),
      recovery: timedRecord(["backup", "migration", "rollback", "restore"] as const),
      platform: {
        chromium: timedRecord(["install", "offline", "update", "accessibility"] as const),
        ios: timedRecord(["install", "offline", "update", "accessibility"] as const),
      },
      cost: {
        model: { source: "run-ledger" as const, microUsd: seed * 1000 },
        transcription: { source: "not-used" as const, microUsd: 0 as const },
      },
    },
  });
}

function ok(durationMs: number) {
  return { outcome: "ok" as const, durationMs };
}

function failed(durationMs: number) {
  return { outcome: "failed" as const, durationMs };
}

function notRun() {
  return { outcome: "not-run" as const, durationMs: null };
}

function capture(seed: number) {
  return {
    "start-to-local": ok(seed),
    "start-to-commit": ok(seed + 1),
    "start-to-adopt": ok(seed + 2),
    lostLogicalCaptures: 0,
    duplicateLogicalCaptures: 0,
  };
}

async function cliError(path: string): Promise<string> {
  const result = await runCli(["validate", "--input", path, "--expected-receipt", RECEIPT]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout).error as string;
}

async function runCli(args: string[], addExpectedVersion = true) {
  const completeArgs = args.includes("--expected-version") || !addExpectedVersion
    ? args
    : [...args, "--expected-version", VERSION];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "..", "scripts", "home-beta-evidence.ts"), ...completeArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
