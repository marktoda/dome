import { describe, expect, test } from "bun:test";

import {
  SETUP_PLAN_SCHEMA,
  VAULT_ASSESSMENT_SCHEMA,
  validateSetupPlan,
  validateVaultAssessment,
  type SetupPlan,
  type VaultAssessment,
} from "../../src/setup/contracts";

const HEAD = "1".repeat(40);
const FINGERPRINT = "2".repeat(64);
const ARTIFACT = "3".repeat(64);
const MANIFEST = "4".repeat(64);
const SERVICE = "com.dome.home.example-vault";

function assessment(): VaultAssessment {
  return validateVaultAssessment({
    schema: VAULT_ASSESSMENT_SCHEMA,
    target: { path: "/Users/example/Vault", kind: "existing-git-vault" },
    revision: { head: HEAD, worktreeFingerprint: FINGERPRINT },
    host: { platform: "darwin", architecture: "arm64", supported: true },
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
    prerequisites: [
      { id: "bun", status: "available", version: "1.2.13" },
      { id: "git", status: "available", version: "2.50.1" },
    ],
    git: { state: "clean", branch: "main" },
    dome: { state: "absent", contentScope: "absent" },
    installedHome: {
      state: "absent",
      artifactId: null,
      productVersion: null,
      buildCommit: null,
      manifestSha256: null,
      selectedVaultPath: null,
    },
    markdown: {
      tracked: ["notes/hello.md"],
      untracked: [],
      proposedScope: { version: 1, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] },
    },
    blockers: [],
  });
}

function plan(): SetupPlan {
  const assessed = assessment();
  return validateSetupPlan({
    schema: SETUP_PLAN_SCHEMA,
    status: "ready",
    assessment: assessed,
    actions: [
      { kind: "ensure-scaffold-directory", id: "dome-directory", path: ".dome", mode: "0755", ifMissing: true },
      { kind: "ensure-scaffold-directory", id: "dome-state-directory", path: ".dome/state", mode: "0700", ifMissing: true },
      {
        kind: "write-scaffold-file", id: "agents-orientation", path: "AGENTS.md",
        bytes: 10, sha256: FINGERPRINT, mode: "0644", ifMissing: true,
      },
      {
        kind: "write-scaffold-file", id: "gitignore", path: ".gitignore",
        bytes: 12, sha256: MANIFEST, mode: "0644", ifMissing: true,
      },
      {
        kind: "set-content-scope",
        id: "vault-config",
        scope: assessed.markdown.proposedScope,
        write: {
          path: ".dome/config.yaml", operation: "create-file", bytes: 100,
          sha256: ARTIFACT, mode: "0644", ifMissing: true,
        },
      },
      {
        kind: "activate-home",
        id: "home-activation",
        artifactId: ARTIFACT,
        disposition: "install-or-resume",
        vaultPath: assessed.target.path,
        serviceLabel: SERVICE,
        installServiceIfMissing: true,
      },
    ],
    optionalSteps: [
      { kind: "configure-integration", description: "Connect an optional source." },
      { kind: "configure-model", description: "Configure a model provider." },
    ],
    recoveryCommands: ["dome setup --dry-run /Users/example/Vault"],
    warnings: [{ code: "review-content-scope", message: "Review the scope." }],
  });
}

describe("VaultAssessment contract", () => {
  test("accepts one canonical revision-bound observation with no action projection", () => {
    const value = assessment();
    expect(validateVaultAssessment(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value).not.toHaveProperty("actions");
  });

  test("rejects unknown fields, non-canonical paths, and case-variant Markdown", () => {
    const value = assessment();
    expect(() => validateVaultAssessment({ ...value, surprise: true })).toThrow();
    expect(() => validateVaultAssessment({
      ...value,
      markdown: { ...value.markdown, tracked: ["z.md", "a.md"] },
    })).toThrow("must be sorted and unique");
    expect(() => validateVaultAssessment({
      ...value,
      markdown: { ...value.markdown, tracked: ["notes/hello.MD"] },
    })).toThrow("lowercase-suffix Markdown");
  });

  test("binds content-scope state to config presence and compatibility", () => {
    const value = assessment();
    expect(() => validateVaultAssessment({
      ...value,
      dome: { state: "absent", contentScope: "configured" },
    })).toThrow("cannot exist without Dome config");
    expect(() => validateVaultAssessment({
      ...value,
      dome: { state: "configured", contentScope: "incompatible" },
    })).toThrow("must be incompatible exactly when Dome config is incompatible");
  });

  test("requires blockers to agree with unsafe evidence", () => {
    const value = assessment();
    expect(() => validateVaultAssessment({
      ...value,
      host: { ...value.host, supported: false },
    })).toThrow("unsupported-host");
    expect(() => validateVaultAssessment({
      ...value,
      git: { ...value.git, state: "dirty" },
    })).toThrow("dirty-worktree");
  });
});

describe("SetupPlan contract", () => {
  test("keeps one canonical action inventory and one atomic Home activation", () => {
    const value = plan();
    expect(validateSetupPlan(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value).not.toHaveProperty("writes");
    expect(value).not.toHaveProperty("commits");
    expect(value).not.toHaveProperty("serviceActions");
    expect(value.actions.filter((action) => action.kind === "activate-home")).toHaveLength(1);
  });

  test("a blocked plan carries no applicable action", () => {
    const ready = plan();
    const blockedAssessment = {
      ...ready.assessment,
      target: { ...ready.assessment.target, kind: "unsafe-or-ambiguous-state" as const },
      blockers: [{
        code: "symlink-ambiguity" as const,
        message: "The vault path is redirected.",
        nextAction: "Choose a direct path.",
      }],
    };
    expect(validateSetupPlan({
      ...ready,
      status: "blocked",
      assessment: blockedAssessment,
      actions: [],
    }).actions).toEqual([]);
    expect(() => validateSetupPlan({ ...ready, status: "blocked", assessment: blockedAssessment })).toThrow(
      "blocked plan must contain no applicable actions",
    );
  });

  test("requires the complete canonical action set and unique write targets", () => {
    const value = plan();
    expect(() => validateSetupPlan({ ...value, actions: [...value.actions].reverse() })).toThrow("canonical order");
    expect(() => validateSetupPlan({ ...value, actions: [...value.actions, value.actions[0]] })).toThrow();
    expect(() => validateSetupPlan({
      ...value,
      actions: value.actions.filter((action) => action.id !== "agents-orientation"),
    })).toThrow("must exactly match the assessed setup work");
    const writes = value.actions.map((action) => action.kind === "write-scaffold-file" && action.id === "gitignore"
      ? { ...action, path: "AGENTS.md" }
      : action);
    expect(() => validateSetupPlan({ ...value, actions: writes })).toThrow();
  });

  test("binds scope migration operation to assessed config presence", () => {
    const value = plan();
    const existing = {
      ...value,
      assessment: { ...value.assessment, target: { ...value.assessment.target, kind: "existing-dome-vault" as const },
        dome: { state: "configured" as const, contentScope: "absent" as const } },
      actions: value.actions.filter((action) =>
        action.kind !== "ensure-scaffold-directory" && action.kind !== "write-scaffold-file"
      ).map((action) => action.kind === "set-content-scope" ? {
        ...action,
        write: { ...action.write, operation: "merge-managed-config" as const, ifMissing: false },
      } : action),
    };
    expect(validateSetupPlan(existing).actions.find((action) => action.kind === "set-content-scope")?.write.operation)
      .toBe("merge-managed-config");
    expect(() => validateSetupPlan({
      ...existing,
      actions: existing.actions.map((action) => action.kind === "set-content-scope" ? {
        ...action,
        write: { ...action.write, operation: "create-file" as const, ifMissing: true },
      } : action),
    })).toThrow("write operation must match config presence");
  });

  test("binds atomic Home activation to exact package, vault, and disposition", () => {
    const value = plan();
    const activation = value.actions.find((action) => action.kind === "activate-home")!;
    for (const changed of [
      { ...activation, artifactId: MANIFEST },
      { ...activation, vaultPath: "/Users/example/Other" },
      { ...activation, disposition: "upgrade" as const },
    ]) {
      expect(() => validateSetupPlan({
        ...value,
        actions: value.actions.map((action) => action.kind === "activate-home" ? changed : action),
      })).toThrow();
    }
  });
});
