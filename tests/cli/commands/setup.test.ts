import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSetup } from "../../../src/cli/commands/setup";
import { compileSetupPlan, type SetupCompilerInput } from "../../../src/setup/compiler";
import { setupPlanSha256 } from "../../../src/setup/consent";
import {
  SETUP_APPLY_RESULT_SCHEMA,
  validateSetupApplyResult,
} from "../../../src/setup/contracts";
import { adaptVault } from "../../../src/setup/vault-adaptation";

const HEAD = "1".repeat(40);
const HASH = "2".repeat(64);
const TARGET = join(realpathSync(tmpdir()), "dome-setup-unit-vault");
const OTHER_TARGET = join(realpathSync(tmpdir()), "dome-setup-unit-other-vault");

function evidence(blocked = false): SetupCompilerInput {
  return {
    source: {
      schema: "dome.setup.vault-source-inspection/v1",
      targetPath: TARGET,
      targetState: blocked ? "existing" : "missing",
      kind: blocked ? "unsafe-or-ambiguous-state" : "new-path",
      git: {
        state: "absent", head: null, branch: null, direct: false, ancestorRoot: null, operationMarkers: [],
      },
      dome: {
        state: "absent",
        contentScope: "absent",
        scaffold: {
          domeDirectory: false,
          stateDirectory: false,
          agentsOrientation: false,
          claudeOrientation: false,
          gitignore: false,
        },
      },
      markdown: { tracked: [], untracked: [] },
      repository: { candidates: [], baselineTracked: [] },
      blockers: blocked ? [{
        code: "symlink-ambiguity",
        message: "The selected path is redirected.",
        nextAction: "Choose a direct path, then reassess.",
      }] : [],
      worktreeFingerprint: HASH,
    },
    host: { platform: "darwin", architecture: "arm64" },
    prerequisites: { bun: "1.2.13", git: "2.50.1" },
    product: {
      distribution: "packaged",
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: HEAD,
      productManifestSha256: HASH,
      packagedHome: { artifactId: HASH, productVersion: "0.4.0", buildCommit: HEAD, manifestSha256: HASH },
    },
    installedHome: {
      state: "absent", artifactId: null, productVersion: null, buildCommit: null,
      manifestSha256: null, selectedVaultPath: null,
    },
    contentScope: { version: 1, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] },
    scaffold: {
      agentsOrientation: "# Vault\n",
      claudeOrientation: "@AGENTS.md\n",
      gitignore: ".dome/state/\n",
      vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
      contentScopeConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
    },
  };
}

let output: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
const roots: string[] = [];

beforeEach(() => {
  output = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => output.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function planFile(plan = compileSetupPlan(evidence())): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-setup-plan-"));
  roots.push(root);
  const path = join(root, "plan.json");
  await writeFile(path, JSON.stringify(plan));
  return path;
}

describe("runSetup", () => {
  test("requires dry-run before invoking discovery", async () => {
    let calls = 0;
    expect(await runSetup({}, { discover: async () => { calls++; return evidence(); } })).toBe(64);
    expect(calls).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("choose exactly one");
  });

  test("prints the exact validated plan as JSON", async () => {
    const input = evidence();
    expect(await runSetup({ dryRun: true, json: true }, { discover: async () => input })).toBe(0);
    expect(JSON.parse(output.join("\n"))).toEqual(compileSetupPlan(input));
  });

  test("reports a blocked preview without presenting applicable work", async () => {
    const input = evidence(true);
    expect(await runSetup({ dryRun: true }, { discover: async () => input })).toBe(1);
    const text = output.join("\n");
    expect(text).toContain("Status: blocked");
    expect(text).toContain("The selected path is redirected.");
    expect(text).toContain("No changes were made.");
    expect(text).not.toContain("Planned actions:");
  });

  test("applies only the plan matching the explicit consent digest", async () => {
    const input = evidence();
    const plan = compileSetupPlan(input);
    const digest = setupPlanSha256(plan);
    const file = await planFile(plan);
    let calls = 0;
    const code = await runSetup({
      path: plan.assessment.target.path,
      apply: true,
      plan: file,
      consent: digest,
      json: true,
    }, {
      discover: async () => input,
      apply: async (receivedPlan, consent) => {
        calls++;
        expect(receivedPlan).toEqual(plan);
        expect(consent.planSha256).toBe(digest);
        return validateSetupApplyResult({
          schema: SETUP_APPLY_RESULT_SCHEMA,
          status: "completed",
          planSha256: digest,
          targetPath: plan.assessment.target.path,
          commits: { baseline: null, configuration: HEAD },
        });
      },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      status: "completed",
      planSha256: digest,
    });
  });

  test("returns the fresh plan from the applier for ordinary stale state", async () => {
    let calls = 0;
    const staleDigest = "f".repeat(64);
    const plan = compileSetupPlan(evidence());
    const file = await planFile(plan);
    expect(await runSetup({
      path: plan.assessment.target.path,
      apply: true,
      plan: file,
      consent: setupPlanSha256(plan),
      json: true,
    }, {
      apply: async () => {
        calls++;
        return validateSetupApplyResult({
          schema: SETUP_APPLY_RESULT_SCHEMA,
          status: "stale",
          planSha256: staleDigest,
          freshPlan: plan,
        });
      },
    })).toBe(1);
    expect(calls).toBe(1);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      status: "stale",
      planSha256: staleDigest,
      freshPlan: { schema: "dome.setup.plan/v1" },
    });
  });

  test("rejects ambiguous or malformed noninteractive grammar before discovery", async () => {
    let calls = 0;
    const deps = { discover: async () => { calls++; return evidence(); } };
    expect(await runSetup({ dryRun: true, apply: true }, deps)).toBe(64);
    expect(await runSetup({ apply: true }, deps)).toBe(64);
    expect(await runSetup({ apply: true, plan: "ignored", consent: "ABC" }, deps)).toBe(64);
    expect(await runSetup({ apply: true, consent: HASH }, deps)).toBe(64);
    expect(await runSetup({ dryRun: true, consent: HASH }, deps)).toBe(64);
    expect(await runSetup({ dryRun: true, plan: "ignored" }, deps)).toBe(64);
    expect(calls).toBe(0);
  });

  test("rejects a tampered plan file and a digest mismatch before discovery or mutation", async () => {
    const plan = compileSetupPlan(evidence());
    const file = await planFile(plan);
    await writeFile(file, `${JSON.stringify(plan)} owner-tamper-marker`);
    let calls = 0;
    const deps = { discover: async () => { calls++; return evidence(); } };
    expect(await runSetup({
      apply: true,
      plan: file,
      consent: setupPlanSha256(plan),
      json: true,
    }, deps)).toBe(64);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ error: "usage" });
    expect(output.join("\n")).not.toContain("owner-tamper-marker");
    expect(calls).toBe(0);

    output = [];
    await writeFile(file, JSON.stringify(plan));
    expect(await runSetup({
      apply: true,
      plan: file,
      consent: "e".repeat(64),
      json: true,
    }, deps)).toBe(1);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      status: "blocked",
      planSha256: setupPlanSha256(plan),
      recovery: { code: "consent-mismatch" },
    });
    expect(calls).toBe(0);
  });

  test("the deep adaptation Module reports actual plan identity and checks digest before target", async () => {
    const plan = compileSetupPlan(evidence());
    const actualDigest = setupPlanSha256(plan);
    let calls = 0;
    await expect(adaptVault({
      mode: "apply",
      targetPath: "/Users/example/Another-Vault",
      plan,
      consentSha256: "not-a-digest",
    }, {
      discover: async () => { calls++; return evidence(); },
    })).rejects.toThrow();

    for (const candidate of [
      {
        targetPath: plan.assessment.target.path,
        consentSha256: "e".repeat(64),
        message: "does not match the retained setup plan",
      },
      {
        targetPath: OTHER_TARGET,
        consentSha256: "e".repeat(64),
        message: "does not match the retained setup plan",
      },
      {
        targetPath: OTHER_TARGET,
        consentSha256: actualDigest,
        message: "targets a different vault",
      },
    ]) {
      const outcome = await adaptVault({ mode: "apply", plan, ...candidate }, {
        discover: async () => { calls++; return evidence(); },
        apply: async () => { calls++; throw new Error("must not mutate"); },
      });
      expect(outcome.mode).toBe("apply");
      if (outcome.mode !== "apply") throw new Error("expected apply outcome");
      expect(outcome.result).toMatchObject({
        status: "blocked",
        planSha256: actualDigest,
        recovery: { code: "consent-mismatch", message: expect.stringContaining(candidate.message) },
      });
    }
    expect(calls).toBe(0);
  });
});
