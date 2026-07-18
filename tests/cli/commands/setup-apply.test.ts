import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSetup, type RunSetupDeps } from "../../../src/cli/commands/setup";
import { type SetupCompilerInput } from "../../../src/setup/compiler";
import { setupPlanSha256 } from "../../../src/setup/consent";
import type { SetupPlan } from "../../../src/setup/contracts";
import { inspectSetupVaultSource } from "../../../src/setup/vault-inspector";
import { commit, initRepo, statusMatrix } from "../../../src/git";
import type { SetupDurableBoundary } from "../../../src/setup/apply";

const HEAD = "1".repeat(40);
const HASH = "2".repeat(64);
const scope = { version: 1 as const, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] };
const scaffold = {
  agentsOrientation: "# Dome vault\n",
  claudeOrientation: "@AGENTS.md\n",
  gitignore: ".dome/state/\n",
  vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
  contentScopeConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
};

const roots: string[] = [];
let output: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

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

async function evidence(target: string): Promise<SetupCompilerInput> {
  return {
    source: await inspectSetupVaultSource(target),
    host: { platform: "darwin", architecture: "arm64" },
    prerequisites: { bun: "1.2.13", git: "2.50.1" },
    product: {
      distribution: "packaged",
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: HEAD,
      productManifestSha256: HASH,
      packagedHome: {
        artifactId: HASH,
        productVersion: "0.4.0",
        buildCommit: HEAD,
        manifestSha256: HASH,
      },
    },
    installedHome: {
      state: "absent", artifactId: null, productVersion: null, buildCommit: null,
      manifestSha256: null, selectedVaultPath: null,
    },
    contentScope: scope,
    scaffold,
  };
}

function deps(): RunSetupDeps {
  return {
    contentScope: scope,
    scaffold,
    discover: async (target) => evidence(target),
  };
}

async function fixture(kind: "new" | "non-git" | "git"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-cli-setup-")));
  roots.push(root);
  const target = kind === "new" ? join(root, "Vault") : root;
  if (kind !== "new") await writeFile(join(target, "Owner.md"), "# Owner\n");
  if (kind === "git") {
    await initRepo(target);
    await commit({ path: target, files: ["Owner.md"], message: "Owner history" });
  }
  return target;
}

async function preview(target: string): Promise<SetupPlan> {
  output = [];
  expect(await runSetup({ path: target, dryRun: true, json: true }, deps())).toBe(0);
  return JSON.parse(output.join("\n")) as SetupPlan;
}

async function apply(target: string, plan: SetupPlan): Promise<Record<string, unknown>> {
  output = [];
  const digest = setupPlanSha256(plan);
  const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-cli-plan-")));
  roots.push(carrier);
  const planPath = join(carrier, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  expect(await runSetup({ path: target, apply: true, plan: planPath, consent: digest, json: true }, deps())).toBe(0);
  return JSON.parse(output.join("\n")) as Record<string, unknown>;
}

describe("setup command vault adaptation", () => {
  for (const kind of ["new", "non-git", "git"] as const) {
    test(`applies a ${kind} vault and leaves owner bytes clean`, async () => {
      const target = await fixture(kind);
      const plan = await preview(target);
      expect((await apply(target, plan)).status).toBe("completed");
      expect(existsSync(join(target, ".dome", "config.yaml"))).toBe(true);
      expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
    });
  }

  test("an already-Dome vault is an idempotent completed no-op", async () => {
    const target = await fixture("new");
    await apply(target, await preview(target));
    const settled = await preview(target);
    expect(settled.assessment.target.kind).toBe("existing-dome-vault");
    expect(settled.actions).toEqual([]);
    expect((await apply(target, settled)).status).toBe("completed");
  });

  test("repairs missing scaffold independently of an existing Dome config", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome"));
    await writeFile(join(target, ".dome", "config.yaml"), scaffold.vaultConfig);
    await commit({ path: target, files: [".dome/config.yaml"], message: "Configure Dome" });

    const plan = await preview(target);
    expect(plan.assessment.target.kind).toBe("existing-dome-vault");
    expect(plan.actions.map((action) => action.id)).toEqual([
      "dome-state-directory",
      "agents-orientation",
      "claude-orientation",
      "gitignore",
    ]);
    expect((await apply(target, plan)).status).toBe("completed");
    expect(existsSync(join(target, ".dome", "state"))).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
    expect(await readFile(join(target, "CLAUDE.md"), "utf8")).toBe(scaffold.claudeOrientation);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect((await preview(target)).actions).toEqual([]);
  });

  test("migrates a configured pre-scope vault through one create-only overlay", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome", "state"), { recursive: true });
    await writeFile(join(target, ".dome", "config.yaml"), "grants: standard\n");
    await writeFile(join(target, "AGENTS.md"), scaffold.agentsOrientation);
    await writeFile(join(target, "CLAUDE.md"), scaffold.claudeOrientation);
    await writeFile(join(target, ".gitignore"), scaffold.gitignore);
    await commit({
      path: target,
      files: [".dome/config.yaml", "AGENTS.md", "CLAUDE.md", ".gitignore"],
      message: "Configure pre-scope Dome",
    });

    const plan = await preview(target);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "set-content-scope",
      id: "content-scope",
      write: { path: ".dome/content-scope.yaml", operation: "create-file" },
    });
    expect((await apply(target, plan)).status).toBe("completed");
    expect(existsSync(join(target, ".dome", "content-scope.yaml"))).toBe(true);
    expect((await preview(target)).actions).toEqual([]);
  });

  test("the recommended external plan file does not stale the inspected vault revision", async () => {
    const target = await fixture("new");
    const plan = await preview(target);
    const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-setup-plan-")));
    roots.push(carrier);
    const planPath = join(carrier, "plan.json");
    expect(planPath.startsWith(`${target}/`)).toBe(false);
    await writeFile(planPath, JSON.stringify(plan));

    output = [];
    expect(await runSetup({
      path: target,
      apply: true,
      plan: planPath,
      consent: setupPlanSha256(plan),
      json: true,
    }, deps())).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "completed" });
  });

  test("preview and apply freeze a parent alias to one canonical target", async () => {
    const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-setup-alias-")));
    roots.push(carrier);
    const root = join(carrier, "actual-parent");
    const alias = join(carrier, "vault-parent");
    await mkdir(root);
    await symlink(root, alias);
    const selected = join(alias, "Vault");
    const canonical = join(root, "Vault");

    const plan = await preview(selected);
    expect(plan.assessment.target.path).toBe(canonical);
    expect((await apply(selected, plan)).status).toBe("completed");
    expect(existsSync(join(canonical, ".git"))).toBe(true);
  });

  test("retargeting a parent alias after preview cannot redirect retained consent", async () => {
    const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-setup-alias-race-")));
    roots.push(carrier);
    const approvedParent = join(carrier, "approved-parent");
    const replacementParent = join(carrier, "replacement-parent");
    const alias = join(carrier, "vault-parent");
    await mkdir(approvedParent);
    await mkdir(replacementParent);
    await symlink(approvedParent, alias);
    const selected = join(alias, "Vault");
    const plan = await preview(selected);

    await unlink(alias);
    await symlink(replacementParent, alias);
    output = [];
    const planCarrier = await realpath(await mkdtemp(join(tmpdir(), "dome-cli-plan-")));
    roots.push(planCarrier);
    const planPath = join(planCarrier, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    expect(await runSetup({
      path: selected,
      apply: true,
      plan: planPath,
      consent: setupPlanSha256(plan),
      json: true,
    }, deps())).toBe(1);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      status: "blocked",
      recovery: { code: "consent-mismatch" },
    });
    expect(existsSync(join(replacementParent, "Vault"))).toBe(false);
  });

  test("stale consent returns fresh evidence and performs no mutation", async () => {
    const target = await fixture("non-git");
    const plan = await preview(target);
    const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-cli-plan-")));
    roots.push(carrier);
    const planPath = join(carrier, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(join(target, "Later.md"), "# Later\n");
    output = [];
    expect(await runSetup({
      path: target,
      apply: true,
      plan: planPath,
      consent: setupPlanSha256(plan),
      json: true,
    }, deps())).toBe(1);
    const result = JSON.parse(output.join("\n")) as { status: string; freshPlan: SetupPlan };
    expect(result.status).toBe("stale");
    expect(result.freshPlan.assessment.repository.baselineTracked).toContain("Later.md");
    expect(existsSync(join(target, ".git"))).toBe(false);
  });

  test("a blocked dirty Git vault is explained without applying actions", async () => {
    const target = await fixture("git");
    await writeFile(join(target, "Owner.md"), "# Dirty\n");
    output = [];
    expect(await runSetup({ path: target, dryRun: true, json: true }, deps())).toBe(1);
    const plan = JSON.parse(output.join("\n")) as SetupPlan;
    expect(plan.status).toBe("blocked");
    expect(plan.actions).toEqual([]);
    output = [];
    const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-cli-plan-")));
    roots.push(carrier);
    const planPath = join(carrier, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    expect(await runSetup({
      path: target,
      apply: true,
      plan: planPath,
      consent: setupPlanSha256(plan),
      json: true,
    }, deps())).toBe(1);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      status: "blocked",
      recovery: { code: "plan-blocked" },
    });
    expect(existsSync(join(target, ".dome"))).toBe(false);
  });

  for (const boundary of ["git-initialized", "configuration-ref-advanced"] as const satisfies ReadonlyArray<SetupDurableBoundary>) {
    test(`recovers in a new process after ${boundary} using the retained plan`, async () => {
      const target = await fixture("new");
      const plan = await preview(target);
      const digest = setupPlanSha256(plan);
      const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-cli-plan-")));
      roots.push(carrier);
      const planPath = join(carrier, "plan.json");
      await writeFile(planPath, JSON.stringify(plan));
      const fixturePath = join(import.meta.dir, "..", "fixtures", "setup-apply-process.ts");

      const interrupted = Bun.spawn([
        process.execPath, fixturePath, target, planPath, digest, boundary,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(await interrupted.exited).not.toBe(0);
      await new Response(interrupted.stdout).text();
      await new Response(interrupted.stderr).text();

      const retry = Bun.spawn([
        process.execPath, fixturePath, target, planPath, digest,
      ], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        retry.exited,
        new Response(retry.stdout).text(),
        new Response(retry.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ status: "completed", planSha256: digest });
      expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
    });
  }
});
