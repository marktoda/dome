import { describe, expect, test } from "bun:test";

import {
  SETUP_PREREQUISITE_POLICY,
  compileSetupPlan,
  setupRevisionFingerprint,
  type SetupCompilerInput,
} from "../../src/setup/compiler";
import { VAULT_KINDS, validateSetupPlan } from "../../src/setup/contracts";
import { renderSetupPlanHuman, renderSetupPlanJson } from "../../src/setup/render";

const HEAD = "1".repeat(40);
const SOURCE_FINGERPRINT = "2".repeat(64);
const ARTIFACT = "3".repeat(64);
const MANIFEST = "4".repeat(64);

function input(kind: SetupCompilerInput["source"]["kind"]): SetupCompilerInput {
  const gitPresent = kind === "existing-git-vault" || kind === "existing-dome-vault" ||
    kind === "incompatible-active-operation" || kind === "unsafe-or-ambiguous-state";
  const blocked = kind === "incompatible-active-operation" || kind === "unsafe-or-ambiguous-state";
  return {
    source: {
      schema: "dome.setup.vault-source-inspection/v1",
      targetPath: "/Users/example/Vault",
      kind,
      git: {
        state: kind === "incompatible-active-operation" ? "operation-active" : gitPresent ? "clean" : "absent",
        head: gitPresent ? HEAD : null,
        branch: gitPresent ? "main" : null,
        direct: gitPresent,
        ancestorRoot: null,
        operationMarkers: kind === "incompatible-active-operation" ? ["MERGE_HEAD"] : [],
      },
      dome: {
        state: kind === "existing-dome-vault" ? "configured" : "absent",
        contentScope: kind === "existing-dome-vault" ? "configured" : "absent",
      },
      markdown: {
        tracked: gitPresent ? ["notes/hello.md"] : [],
        untracked: kind === "existing-non-git-vault" ? ["Journal.md"] : [],
      },
      blockers: kind === "incompatible-active-operation" ? [{
        code: "active-git-operation",
        message: "A Git operation is active.",
        nextAction: "Finish or abort the Git operation, then reassess.",
      }] : blocked ? [{
        code: "symlink-ambiguity",
        message: "The selected path contains an ambiguous link.",
        nextAction: "Choose a direct vault path, then reassess.",
      }] : [],
      worktreeFingerprint: SOURCE_FINGERPRINT,
    },
    host: { platform: "darwin", architecture: "arm64" },
    prerequisites: { bun: "1.2.13", git: "2.50.1" },
    product: {
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: HEAD,
      productManifestSha256: MANIFEST,
      packagedHome: {
        artifactId: ARTIFACT,
        productVersion: "0.4.0",
        buildCommit: HEAD,
        manifestSha256: MANIFEST,
      },
    },
    installedHome: {
      state: "absent",
      artifactId: null,
      productVersion: null,
      buildCommit: null,
      manifestSha256: null,
      selectedVaultPath: null,
    },
    contentScope: { version: 1, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] },
    scaffold: {
      agentsOrientation: "# Dome vault\n",
      gitignore: ".dome/state/\n",
      vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
      contentScopeConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
    },
  };
}

describe("setup compiler", () => {
  test("compiles every closed classification into one exact plan payload", () => {
    const plans = Object.fromEntries(VAULT_KINDS.map((kind) => [kind, compileSetupPlan(input(kind))]));
    expect(JSON.stringify(plans, null, 2)).toMatchSnapshot();
  });

  test("is deterministic and binds all injected evidence into the revision", () => {
    const evidence = input("existing-git-vault");
    expect(compileSetupPlan(evidence)).toEqual(compileSetupPlan(structuredClone(evidence)));
    const mutations: ReadonlyArray<SetupCompilerInput> = [
      { ...evidence, source: { ...evidence.source, worktreeFingerprint: "8".repeat(64) } },
      { ...evidence, host: { ...evidence.host, architecture: "x64" } },
      { ...evidence, prerequisites: { ...evidence.prerequisites, bun: "1.2.14" } },
      { ...evidence, prerequisites: { ...evidence.prerequisites, git: "2.49.0" } },
      { ...evidence, product: { ...evidence.product, productManifestSha256: "9".repeat(64) } },
      { ...evidence, installedHome: { ...evidence.installedHome, state: "ambiguous" } },
      { ...evidence, scaffold: { ...evidence.scaffold, agentsOrientation: "# Different orientation\n" } },
      { ...evidence, scaffold: { ...evidence.scaffold, gitignore: ".dome/state/\n.DS_Store\n" } },
      {
        ...evidence,
        contentScope: { ...evidence.contentScope, include: ["notes/**/*.md"] },
        scaffold: {
          ...evidence.scaffold,
          vaultConfig: "content_scope:\n  version: 1\n  include: [\"notes/**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
          contentScopeConfig: "content_scope:\n  version: 1\n  include: [\"notes/**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
        },
      },
    ];
    const baseline = setupRevisionFingerprint(evidence);
    for (const changed of mutations) expect(setupRevisionFingerprint(changed)).not.toBe(baseline);
    expect(() => setupRevisionFingerprint({
      ...evidence,
      contentScope: { ...evidence.contentScope, include: ["notes/**/*.md"] },
    })).toThrow("does not encode the proposed content scope");
  });

  test("applies minimum versions to injected observations without discovering tools", () => {
    expect(SETUP_PREREQUISITE_POLICY).toEqual({ bun: ">=1.2.13 <2", git: ">=2.45.0" });
    const oldGit = input("new-path");
    const unsupported = compileSetupPlan({ ...oldGit, prerequisites: { bun: "1.2.13", git: "2.44.4" } });
    expect(unsupported.status).toBe("blocked");
    expect(unsupported.assessment.prerequisites[1]).toEqual({ id: "git", status: "unsupported", version: "2.44.4" });
    expect(unsupported.assessment.blockers.map((row) => row.code)).toEqual(["unsupported-prerequisite"]);

    const missing = compileSetupPlan({ ...oldGit, prerequisites: { bun: null, git: "2.50.1" } });
    expect(missing.status).toBe("blocked");
    expect(missing.assessment.prerequisites[0]).toEqual({ id: "bun", status: "missing", version: null });
  });

  test("classifies host and installed Home conflicts before emitting actions", () => {
    const base = input("existing-dome-vault");
    const active = compileSetupPlan({
      ...base,
      installedHome: { ...base.installedHome, state: "upgrade-active" },
    });
    expect(active.assessment.target.kind).toBe("incompatible-active-operation");
    expect(active.actions).toEqual([]);
    expect(active.assessment.blockers.map((row) => row.code)).toEqual(["active-home-upgrade"]);

    const unsupported = compileSetupPlan({ ...base, host: { platform: "linux", architecture: "x64" } });
    expect(unsupported.assessment.target.kind).toBe("unsafe-or-ambiguous-state");
    expect(unsupported.assessment.blockers.map((row) => row.code)).toEqual(["unsupported-host"]);
  });

  test("uses upgrade only for a different exact owned artifact", () => {
    const base = input("existing-dome-vault");
    const installed = {
      state: "owned" as const,
      artifactId: "5".repeat(64),
      productVersion: "0.3.0",
      buildCommit: "6".repeat(40),
      manifestSha256: "7".repeat(64),
      selectedVaultPath: base.source.targetPath,
    };
    const plan = compileSetupPlan({ ...base, installedHome: installed });
    expect(plan.actions.at(-1)).toMatchObject({ kind: "activate-home", disposition: "upgrade" });

    const exact = compileSetupPlan({
      ...base,
      installedHome: {
        state: "owned",
        artifactId: ARTIFACT,
        productVersion: "0.4.0",
        buildCommit: HEAD,
        manifestSha256: MANIFEST,
        selectedVaultPath: base.source.targetPath,
      },
    });
    expect(exact.actions.at(-1)).toMatchObject({ kind: "activate-home", disposition: "install-or-resume" });
  });

  test("plans one explicit managed scope migration for a configured pre-scope vault", () => {
    const base = input("existing-dome-vault");
    const plan = compileSetupPlan({
      ...base,
      source: { ...base.source, dome: { state: "configured", contentScope: "absent" } },
    });
    const scopeActions = plan.actions.filter((action) => action.kind === "set-content-scope");
    expect(scopeActions).toHaveLength(1);
    expect(scopeActions[0]?.write).toMatchObject({
      path: ".dome/config.yaml",
      operation: "merge-managed-config",
      ifMissing: false,
    });
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      "content-scope-migration",
      "review-content-scope",
    ]);
  });

  test("renders human and JSON forms from the same validated plan", () => {
    const plan = compileSetupPlan(input("existing-non-git-vault"));
    expect(JSON.parse(renderSetupPlanJson(plan))).toEqual(plan);
    expect(renderSetupPlanHuman(plan)).toMatchSnapshot();
    expect(renderSetupPlanHuman(plan)).toContain("No changes were made.");
    expect(() => renderSetupPlanHuman({ ...plan, status: "blocked" })).toThrow("must agree with assessment blockers");
  });

  test("fails closed on malformed evidence instead of coercing it", () => {
    const base = input("new-path");
    expect(() => compileSetupPlan({
      ...base,
      product: { ...base.product, packageName: "dome" as "@marktoda/dome" },
    })).toThrow();
    expect(() => compileSetupPlan({
      ...base,
      source: { ...base.source, worktreeFingerprint: "short" },
    })).toThrow("setup source fingerprint is invalid");
    expect(() => compileSetupPlan({
      ...base,
      source: { ...base.source, schema: "forged" as typeof base.source.schema },
    })).toThrow("schema is invalid");
    const existing = input("existing-git-vault");
    expect(() => compileSetupPlan({
      ...existing,
      source: { ...existing.source, git: { ...existing.source.git, direct: false } },
    })).toThrow("Git boundary evidence is inconsistent");
    expect(() => compileSetupPlan({
      ...existing,
      source: { ...existing.source, git: { ...existing.source.git, ancestorRoot: "/Users/example" } },
    })).toThrow("Git boundary evidence is inconsistent");
    expect(() => compileSetupPlan({
      ...existing,
      source: { ...existing.source, git: { ...existing.source.git, operationMarkers: ["MERGE_HEAD"] } },
    })).toThrow("Git operation evidence is inconsistent");
    expect(() => compileSetupPlan({
      ...base,
      scaffold: { ...base.scaffold, vaultConfig: "grants: standard\n" },
    })).toThrow("does not encode the proposed content scope");
    expect(() => compileSetupPlan({
      ...base,
      contentScope: {
        ...base.contentScope,
        exclude: [".git/**", ".dome/**"],
      },
      scaffold: {
        ...base.scaffold,
        vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".git/**\", \".dome/**\"]\n",
      },
    })).toThrow("must be sorted and unique");
    expect(() => compileSetupPlan({
      ...base,
      scaffold: {
        ...base.scaffold,
        vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\", \"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
      },
    })).toThrow("does not encode the proposed content scope");
    expect(() => compileSetupPlan({
      ...base,
      scaffold: { ...base.scaffold, agentsOrientation: "x".repeat(1024 * 1024 + 1) },
    })).toThrow("scaffold exceeds the write budget");
    expect(() => validateSetupPlan({ ...compileSetupPlan(base), surprise: true })).toThrow();
  });
});
