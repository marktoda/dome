import { describe, expect, test } from "bun:test";

import {
  SETUP_PLAN_SCHEMA,
  SETUP_CONSENT_SCHEMA,
  SETUP_APPLY_RESULT_SCHEMA,
  VAULT_ASSESSMENT_SCHEMA,
  validateSetupPlan,
  validateVaultAssessment,
  validateSetupConsent,
  validateSetupApplyResult,
  type SetupPlan,
  type VaultAssessment,
} from "../../src/setup/contracts";

const HEAD = "1".repeat(40);
const FINGERPRINT = "2".repeat(64);
const ARTIFACT = "3".repeat(64);
const MANIFEST = "4".repeat(64);

function assessment(): VaultAssessment {
  return validateVaultAssessment({
    schema: VAULT_ASSESSMENT_SCHEMA,
    target: { path: "/Users/example/Vault", state: "existing", kind: "existing-git-vault" },
    revision: { head: HEAD, worktreeFingerprint: FINGERPRINT },
    host: { platform: "darwin", architecture: "arm64" },
    product: {
      distribution: "packaged",
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
    repository: { candidates: [], baselineTracked: [] },
    blockers: [],
  });
}

function plan(): SetupPlan {
  const assessed = assessment();
  return validateSetupPlan({
    schema: SETUP_PLAN_SCHEMA,
    scope: "vault-adaptation",
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
        kind: "write-scaffold-file", id: "claude-orientation", path: "CLAUDE.md",
        bytes: 11, sha256: FINGERPRINT, mode: "0644", ifMissing: true,
      },
      {
        kind: "write-scaffold-file", id: "gitignore", path: ".gitignore",
        bytes: 12, sha256: MANIFEST, mode: "0644", ifMissing: true,
      },
      {
        kind: "set-content-scope",
        id: "content-scope",
        scope: assessed.markdown.proposedScope,
        write: {
          path: ".dome/config.yaml", operation: "create-file", bytes: 100,
          sha256: ARTIFACT, mode: "0644", ifMissing: true,
        },
      },
    ],
    optionalSteps: [
      { kind: "configure-integration", description: "Connect an optional source." },
      { kind: "configure-model", description: "Configure a model provider." },
    ],
    deferredSteps: [{
      kind: "activate-home",
      milestone: "M6",
      description: "Home activation is separately consented.",
    }],
    recoveryCommands: ["dome setup --dry-run /Users/example/Vault"],
    warnings: [{ code: "review-content-scope", message: "Review the scope." }],
  });
}

describe("VaultAssessment contract", () => {
  test("accepts one canonical revision-bound observation with no action projection", () => {
    const value = assessment();
    expect(validateVaultAssessment(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value).not.toHaveProperty("actions");
    expect(isDeeplyFrozen(value)).toBe(true);
  });

  test("source-tree compatibility evidence cannot claim packaged Home authority", () => {
    const value = assessment();
    const sourceTree = validateVaultAssessment({
      ...value,
      product: {
        distribution: "source-tree",
        packageName: "@marktoda/dome",
        packageVersion: "0.4.0",
        sourceCommit: HEAD,
        sourceTreeSha256: MANIFEST,
        packagedHome: null,
      },
    });
    expect(sourceTree.product.distribution).toBe("source-tree");
    expect(sourceTree.product.packagedHome).toBeNull();
    expect(() => validateVaultAssessment({
      ...value,
      product: { ...sourceTree.product, packagedHome: value.product.packagedHome },
    })).toThrow();
  });

  test("Home-artifact evidence is distinct from packaged Home activation authority", () => {
    const value = assessment();
    const homeArtifact = validateVaultAssessment({
      ...value,
      product: {
        distribution: "home-artifact",
        packageName: "@marktoda/dome",
        packageVersion: "0.4.0",
        sourceCommit: HEAD,
        homeArtifactManifestSha256: MANIFEST,
        packagedHome: null,
      },
    });
    expect(homeArtifact.product.distribution).toBe("home-artifact");
    expect(homeArtifact.product.packagedHome).toBeNull();
    expect(() => validateVaultAssessment({
      ...value,
      product: { ...homeArtifact.product, packagedHome: value.product.packagedHome },
    })).toThrow();
  });

  test("rejects repository rows that forge a safe disposition", () => {
    const value = assessment();
    expect(() => validateVaultAssessment({
      ...value,
      repository: {
        candidates: [{
          path: ".env", kind: "file", bytes: 8, proofSha256: FINGERPRINT,
          contentSha256: null, gitMode: null, tracking: "tracked",
          disposition: "already-tracked", reason: "safe-owner-file",
        }],
        baselineTracked: [],
      },
    })).toThrow("canonical repository boundary");
  });

  test("rejects proxies, accessors, and oversized arrays before traversal", () => {
    let trapCount = 0;
    const hostile = new Proxy({}, {
      getPrototypeOf() { trapCount += 1; throw new Error("must not inspect proxy"); },
      ownKeys() { trapCount += 1; throw new Error("must not inspect proxy"); },
    });
    expect(() => validateVaultAssessment(hostile)).toThrow("must not be a Proxy");
    expect(trapCount).toBe(0);

    let accessorCount = 0;
    const accessor = { ...assessment() } as Record<string, unknown>;
    Object.defineProperty(accessor, "schema", {
      enumerable: true,
      get() { accessorCount += 1; return VAULT_ASSESSMENT_SCHEMA; },
    });
    expect(() => validateVaultAssessment(accessor)).toThrow("must be an enumerable data property");
    expect(accessorCount).toBe(0);

    let elementCount = 0;
    const oversized = new Array(100_001);
    Object.defineProperty(oversized, "0", {
      enumerable: true,
      get() { elementCount += 1; return "notes/never-read.md"; },
    });
    const value = assessment();
    expect(() => validateVaultAssessment({
      ...value,
      markdown: { ...value.markdown, tracked: oversized },
    })).toThrow("must contain at most 100000 entries");
    expect(elementCount).toBe(0);
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
      dome: { ...value.dome, state: "absent", contentScope: "configured" },
    })).toThrow("cannot exist without Dome config");
    expect(() => validateVaultAssessment({
      ...value,
      dome: {
        ...value.dome,
        state: "configured",
        contentScope: "incompatible",
        scaffold: { ...value.dome.scaffold, domeDirectory: true },
      },
    })).toThrow("must be incompatible exactly when Dome config is incompatible");
  });

  test("requires blockers to agree with unsafe evidence", () => {
    const value = assessment();
    expect(() => validateVaultAssessment({
      ...value,
      git: { ...value.git, state: "dirty" },
    })).toThrow("dirty-worktree");
  });

  test("binds classification exactly to configured and active-operation evidence", () => {
    const value = assessment();
    expect(() => validateVaultAssessment({
      ...value,
      dome: {
        ...value.dome,
        state: "configured",
        contentScope: "configured",
        scaffold: { ...value.dome.scaffold, domeDirectory: true },
      },
    })).toThrow("must equal existing-dome-vault");
    expect(() => validateVaultAssessment({
      ...value,
      target: { ...value.target, kind: "incompatible-active-operation" },
    })).toThrow("must equal existing-git-vault");
  });

  test("configured non-Git content remains an existing non-Git vault", () => {
    const value = assessment();
    const configuredNonGit = validateVaultAssessment({
      ...value,
      target: { ...value.target, kind: "existing-non-git-vault" },
      revision: { ...value.revision, head: null },
      git: { state: "absent", branch: null },
      dome: {
        ...value.dome,
        state: "configured",
        contentScope: "configured",
        scaffold: { ...value.dome.scaffold, domeDirectory: true },
      },
      markdown: { ...value.markdown, tracked: [], untracked: ["notes/hello.md"] },
    });
    expect(configuredNonGit.target.kind).toBe("existing-non-git-vault");
  });
});

describe("SetupPlan contract", () => {
  test("keeps one canonical vault-adaptation inventory and explicitly defers Home", () => {
    const value = plan();
    expect(validateSetupPlan(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value).not.toHaveProperty("writes");
    expect(value).not.toHaveProperty("commits");
    expect(value).not.toHaveProperty("serviceActions");
    expect(value.scope).toBe("vault-adaptation");
    expect(value.deferredSteps).toEqual([expect.objectContaining({ kind: "activate-home", milestone: "M6" })]);
    expect(isDeeplyFrozen(value)).toBe(true);
  });

  test("preflights hostile plan arrays before Zod traversal", () => {
    let elementCount = 0;
    const oversized = new Array(100_000);
    Object.defineProperty(oversized, "0", {
      enumerable: true,
      get() { elementCount += 1; return plan().actions[0]; },
    });
    expect(() => validateSetupPlan({ ...plan(), actions: oversized })).toThrow("must contain at most 8 entries");
    expect(elementCount).toBe(0);
  });

  test("enforces one aggregate budget across primitive elements and holes", () => {
    for (const populated of [true, false]) {
      const oversized = () => populated ? new Array(100_000).fill("same.md") : new Array(100_000);
      const value = plan();
      const surplus = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        `surplus${index}`, { tracked: oversized() },
      ]));
      expect(() => validateSetupPlan({
        ...value,
        ...surplus,
        assessment: {
          ...value.assessment,
          markdown: { ...value.assessment.markdown, tracked: oversized(), untracked: oversized() },
        },
      })).toThrow("exceeds the passive data budget");
    }
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

  test("binds the create-only scope document path to assessed config presence", () => {
    const value = plan();
    const existing = {
      ...value,
      assessment: { ...value.assessment, target: { ...value.assessment.target, kind: "existing-dome-vault" as const },
        dome: {
          state: "configured" as const,
          contentScope: "absent" as const,
          scaffold: {
            domeDirectory: true,
            stateDirectory: true,
            agentsOrientation: true,
            claudeOrientation: true,
            gitignore: true,
          },
        } },
      actions: value.actions.filter((action) =>
        action.kind !== "ensure-scaffold-directory" && action.kind !== "write-scaffold-file"
      ).map((action) => action.kind === "set-content-scope" ? {
        ...action,
        write: { ...action.write, path: ".dome/content-scope.yaml" as const },
      } : action),
    };
    expect(validateSetupPlan(existing).actions.find((action) => action.kind === "set-content-scope")?.write.path)
      .toBe(".dome/content-scope.yaml");
    expect(() => validateSetupPlan({
      ...existing,
      actions: existing.actions.map((action) => action.kind === "set-content-scope" ? {
        ...action,
        write: { ...action.write, path: ".dome/config.yaml" as const },
      } : action),
    })).toThrow("write path must match config presence");
  });

  test("validates immutable consent and closed apply results", () => {
    const value = plan();
    const consent = validateSetupConsent({ schema: SETUP_CONSENT_SCHEMA, planSha256: FINGERPRINT });
    expect(consent.planSha256).toBe(FINGERPRINT);
    expect(validateSetupApplyResult({
      schema: SETUP_APPLY_RESULT_SCHEMA,
      status: "stale",
      planSha256: FINGERPRINT,
      freshPlan: value,
    }).status).toBe("stale");
    expect(() => validateSetupConsent({ ...consent, surprise: true })).toThrow();
  });
});

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}
