import { describe, expect, test } from "bun:test";
import {
  SETUP_PLAN_SCHEMA,
  VAULT_ASSESSMENT_SCHEMA,
  VAULT_KINDS,
  type AdaptationAction,
  type SetupPlan,
  type VaultAssessment,
  validateSetupPlan,
  validateVaultAssessment,
} from "../../src/setup/contracts";

const HEAD = "1".repeat(40);
const FINGERPRINT = "2".repeat(64);
const ARTIFACT = "3".repeat(64);
const FILE_HASH = "4".repeat(64);

function fixture(kind: VaultAssessment["target"]["kind"]): VaultAssessment {
  const gitPresent = kind === "existing-git-vault" || kind === "existing-dome-vault" ||
    kind === "incompatible-active-operation" || kind === "unsafe-or-ambiguous-state";
  const blocked = kind === "incompatible-active-operation" || kind === "unsafe-or-ambiguous-state";
  const actions: AdaptationAction[] = [];
  if (!blocked && kind !== "existing-dome-vault") {
    if (kind === "new-path") actions.push({
      kind: "create-vault-directory", id: "vault-directory", path: "/Users/example/Vault", mode: "0755", ifMissing: true,
    });
    if (!gitPresent) actions.push({
      kind: "initialize-git", id: "git-repository", repositoryPath: "/Users/example/Vault", ifMissing: true,
    });
    actions.push(
      { kind: "ensure-scaffold-directory", id: "dome-directory", path: ".dome", mode: "0755", ifMissing: true },
      { kind: "ensure-scaffold-directory", id: "dome-state-directory", path: ".dome/state", mode: "0700", ifMissing: true },
      {
        kind: "write-scaffold-file", id: "agents-orientation", path: "AGENTS.md", bytes: 512,
        sha256: FILE_HASH, mode: "0644", ifMissing: true,
      },
      {
        kind: "write-scaffold-file", id: "gitignore", path: ".gitignore", bytes: 64,
        sha256: FILE_HASH, mode: "0644", ifMissing: true,
      },
      {
        kind: "set-content-scope",
        id: "vault-config",
        scope: { version: 1, include: ["**/*.md"], exclude: [".dome/**"] },
        write: {
          path: ".dome/config.yaml", operation: "create-file", bytes: 128,
          sha256: FILE_HASH, mode: "0644", ifMissing: true,
        },
      },
    );
    if (kind === "existing-non-git-vault") actions.push({
      kind: "create-baseline-commit", id: "baseline-commit", message: "Initialize Dome vault",
      paths: ["Journal.md"],
    });
    actions.push(
      { kind: "install-home", id: "home-artifact", artifactId: ARTIFACT },
      { kind: "select-home-vault", id: "home-vault-selector", vaultPath: "/Users/example/Vault" },
      {
        kind: "install-home-service", id: "home-service", serviceLabel: "com.dome.home.example-vault", ifMissing: true,
      },
      { kind: "start-home", id: "home-start", serviceLabel: "com.dome.home.example-vault" },
    );
  }
  return validateVaultAssessment({
    schema: VAULT_ASSESSMENT_SCHEMA,
    target: { path: "/Users/example/Vault", kind },
    revision: { head: gitPresent ? HEAD : null, worktreeFingerprint: FINGERPRINT },
    host: { platform: "darwin", architecture: "arm64", supported: true },
    product: {
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: HEAD,
      productManifestSha256: ARTIFACT,
      packagedHome: {
        artifactId: ARTIFACT,
        productVersion: "0.4.0",
        buildCommit: HEAD,
        manifestSha256: FILE_HASH,
      },
    },
    prerequisites: [
      { id: "bun", status: "available", version: "1.2.13" },
      { id: "git", status: "available", version: "2.50.1" },
    ],
    git: {
      state: kind === "incompatible-active-operation" ? "operation-active" : gitPresent ? "clean" : "absent",
      branch: gitPresent ? "main" : null,
    },
    dome: { state: kind === "existing-dome-vault" ? "configured" : "absent" },
    installedHome: {
      state: kind === "existing-dome-vault" ? "owned" : "absent",
      artifactId: kind === "existing-dome-vault" ? ARTIFACT : null,
      productVersion: kind === "existing-dome-vault" ? "0.4.0" : null,
      buildCommit: kind === "existing-dome-vault" ? HEAD : null,
      manifestSha256: kind === "existing-dome-vault" ? FILE_HASH : null,
      selectedVaultPath: kind === "existing-dome-vault" ? "/Users/example/Vault" : null,
    },
    markdown: {
      tracked: gitPresent ? ["notes/hello.md"] : [],
      untracked: kind === "existing-non-git-vault" ? ["Journal.md"] : [],
      proposedScope: { version: 1, include: ["**/*.md"], exclude: [".dome/**"] },
    },
    actions,
    blockers: kind === "incompatible-active-operation" ? [{
      code: "active-git-operation",
      message: "A Git operation is active.",
      nextAction: "Finish or abort the Git operation, then reassess.",
    }] : kind === "unsafe-or-ambiguous-state" ? [{
      code: "symlink-ambiguity",
      message: "The selected path contains an ambiguous link.",
      nextAction: "Choose a canonical vault path with no escaping links, then reassess.",
    }] : [],
  });
}

function gitEdgeFixture(state: "detached" | "unborn"): VaultAssessment {
  const unsafe = fixture("unsafe-or-ambiguous-state");
  return validateVaultAssessment({
    ...unsafe,
    revision: { ...unsafe.revision, head: state === "detached" ? HEAD : null },
    git: { state, branch: state === "detached" ? null : "main" },
    blockers: state === "detached" ? [{
      code: "detached-head",
      message: "The repository has a detached HEAD.",
      nextAction: "Check out the intended branch, then reassess.",
    }] : [{
      code: "unborn-repository",
      message: "The repository has no first commit.",
      nextAction: "Create or remove the incomplete repository, then reassess.",
    }],
  });
}

describe("VaultAssessment contract", () => {
  test("every closed vault classification has an exact JSON fixture", () => {
    const fixtures = Object.fromEntries(VAULT_KINDS.map((kind) => [kind, fixture(kind)]));
    expect(JSON.stringify(fixtures, null, 2)).toMatchSnapshot();
  });

  test("detached and unborn Git states have exact fail-closed fixtures", () => {
    expect(JSON.stringify({
      detached: gitEdgeFixture("detached"),
      unborn: gitEdgeFixture("unborn"),
    }, null, 2)).toMatchSnapshot();
  });

  test("rejects unknown fields and non-canonical inventories", () => {
    const valid = fixture("existing-git-vault");
    expect(() => validateVaultAssessment({ ...valid, surprise: true })).toThrow();
    expect(() => validateVaultAssessment({
      ...valid,
      markdown: { ...valid.markdown, tracked: ["z.md", "a.md"] },
    })).toThrow("sorted and unique");
    const { version: _version, ...unversionedScope } = valid.markdown.proposedScope;
    expect(() => validateVaultAssessment({
      ...valid,
      markdown: { ...valid.markdown, proposedScope: unversionedScope },
    })).toThrow();
  });

  test("blocks adaptation actions whenever assessment is unsafe", () => {
    const unsafe = fixture("unsafe-or-ambiguous-state");
    expect(() => validateVaultAssessment({
      ...unsafe,
      actions: [{ kind: "install-home", id: "home-artifact", artifactId: ARTIFACT }],
    })).toThrow("must be empty while assessment is blocked");
  });

  test("binds Git presence to HEAD evidence", () => {
    const existing = fixture("existing-git-vault");
    expect(() => validateVaultAssessment({ ...existing, revision: { ...existing.revision, head: null } })).toThrow(
      "must match Git state clean",
    );
  });

  test("requires fail-closed blockers for observed conflicts", () => {
    const existing = fixture("existing-git-vault");
    expect(() => validateVaultAssessment({
      ...existing,
      target: { ...existing.target, kind: "unsafe-or-ambiguous-state" },
      git: { ...existing.git, state: "dirty" },
    })).toThrow("must agree with dirty-worktree evidence");
  });

  test("binds package, Home artifact, and additive action evidence", () => {
    const existing = fixture("existing-git-vault");
    expect(() => validateVaultAssessment({
      ...existing,
      product: {
        ...existing.product,
        packagedHome: { ...existing.product.packagedHome, buildCommit: "9".repeat(40) },
      },
    })).toThrow("must match the packaged product version and source commit");
    expect(() => validateVaultAssessment({
      ...existing,
      actions: existing.actions.map((action) => action.kind === "set-content-scope" ? {
        ...action,
        write: { ...action.write, path: "config.yaml" },
      } : action),
    })).toThrow();
  });

  test("binds directory and repository actions to compatible assessed targets", () => {
    const fresh = fixture("new-path");
    expect(() => validateVaultAssessment({
      ...fresh,
      actions: fresh.actions.map((action) => action.kind === "create-vault-directory" ?
        { ...action, path: "/Users/example/Other" } : action),
    })).toThrow("must equal the assessed vault path");
    const nonGit = fixture("existing-non-git-vault");
    expect(() => validateVaultAssessment({
      ...nonGit,
      actions: nonGit.actions.map((action) => action.kind === "initialize-git" ?
        { ...action, repositoryPath: "/Users/example/Other" } : action),
    })).toThrow("must equal the assessed vault path");
    const existing = fixture("existing-git-vault");
    expect(() => validateVaultAssessment({
      ...existing,
      actions: [{
        kind: "initialize-git", id: "git-repository", repositoryPath: existing.target.path, ifMissing: true,
      }, ...existing.actions],
    })).toThrow("must initialize Git exactly for a compatible non-Git target");
  });

  test("distinguishes missing from observed-but-unsupported prerequisites", () => {
    const unsafe = fixture("unsafe-or-ambiguous-state");
    const unsupported = validateVaultAssessment({
      ...unsafe,
      prerequisites: [
        { id: "bun", status: "unsupported", version: "1.1.0" },
        { id: "git", status: "available", version: "2.50.1" },
      ],
      blockers: [{
        code: "unsupported-prerequisite",
        message: "The observed Bun version is unsupported.",
        nextAction: "Install a supported Bun version, then reassess.",
      }],
    });
    expect(unsupported.prerequisites[0]?.version).toBe("1.1.0");
    expect(() => validateVaultAssessment({
      ...unsupported,
      prerequisites: [
        { id: "bun", status: "unsupported", version: null },
        { id: "git", status: "available", version: "2.50.1" },
      ],
    })).toThrow("must be null exactly when missing and observed otherwise");
    expect(() => validateVaultAssessment({
      ...unsafe,
      prerequisites: [
        { id: "bun", status: "missing", version: "1.2.13" },
        { id: "git", status: "available", version: "2.50.1" },
      ],
      blockers: [{
        code: "missing-prerequisite",
        message: "Bun is missing.",
        nextAction: "Install Bun, then reassess.",
      }],
    })).toThrow("must be null exactly when missing and observed otherwise");
  });
});

describe("SetupPlan contract", () => {
  test("accepts one self-contained deterministic plan", () => {
    const assessment = fixture("existing-git-vault");
    const plan = validateSetupPlan({
      schema: SETUP_PLAN_SCHEMA,
      status: "ready",
      assessment,
      writes: [
        {
          id: "agents-orientation", path: "AGENTS.md", operation: "create-file", bytes: 512,
          sha256: FILE_HASH, mode: "0644", ifMissing: true,
        },
        {
          id: "gitignore", path: ".gitignore", operation: "create-file", bytes: 64,
          sha256: FILE_HASH, mode: "0644", ifMissing: true,
        },
        {
          id: "vault-config", path: ".dome/config.yaml", operation: "create-file", bytes: 128,
          sha256: FILE_HASH, mode: "0644", ifMissing: true,
        },
      ],
      commits: [{
        kind: "configuration",
        message: "Configure Dome",
        paths: [".dome/config.yaml", ".gitignore", "AGENTS.md"],
      }],
      serviceActions: [
        { kind: "install-home", artifactId: ARTIFACT },
        { kind: "select-home-vault", vaultPath: "/Users/example/Vault" },
        { kind: "install-home-service", serviceLabel: "com.dome.home.example-vault", ifMissing: true },
        { kind: "start-home", serviceLabel: "com.dome.home.example-vault" },
      ],
      optionalSteps: [
        { kind: "configure-integration", description: "Connect an optional source." },
        { kind: "configure-model", description: "Configure a model provider." },
      ],
      recoveryCommands: ["dome check", "dome setup --dry-run /Users/example/Vault"],
      warnings: [{ code: "scope-review", message: "Review the proposed Markdown scope." }],
    });
    expect(validateSetupPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() => validateSetupPlan({
      ...plan,
      writes: plan.writes.map((write) => write.id === "vault-config" ? { ...write, sha256: "8".repeat(64) } : write),
    })).toThrow("must bind content-scope to its exact vault-config write");
    expect(() => validateSetupPlan({
      ...plan,
      commits: [{
        ...plan.commits[0]!,
        paths: [...plan.commits[0]!.paths, "notes/private.md"],
      }],
    })).toThrow("configuration commit paths must equal applicable plan writes");
    expect(() => validateSetupPlan({ ...plan, commits: [] })).toThrow(
      "configuration commit must exist exactly when plan writes apply",
    );
    expect(() => validateSetupPlan({
      ...plan,
      writes: plan.writes.map((write) => write.id === "gitignore" ? { ...write, path: "AGENTS.md" } : write),
    })).toThrow("must not contain duplicate target paths");
    expect(() => validateSetupPlan({
      ...plan,
      serviceActions: plan.serviceActions.map((action) => action.kind === "start-home" ?
        { ...action, serviceLabel: "com.dome.home.other-vault" } : action),
    })).toThrow("must exactly project Home assessment actions");
  });

  test("a blocked plan cannot carry applicable effects", () => {
    const assessment = fixture("incompatible-active-operation");
    expect(() => validateSetupPlan({
      schema: SETUP_PLAN_SCHEMA,
      status: "blocked",
      assessment,
      writes: [{
        id: "agents-orientation", path: "AGENTS.md", operation: "create-file", bytes: 1,
        sha256: FILE_HASH, mode: "0644", ifMissing: true,
      }],
      commits: [],
      serviceActions: [],
      optionalSteps: [],
      recoveryCommands: ["dome setup --dry-run /Users/example/Vault"],
      warnings: [],
    })).toThrow("must contain no applicable writes");
  });

  test("plan status must agree with the nested assessment", () => {
    expect(() => validateSetupPlan({
      schema: SETUP_PLAN_SCHEMA,
      status: "ready",
      assessment: fixture("unsafe-or-ambiguous-state"),
      writes: [],
      commits: [],
      serviceActions: [],
      optionalSteps: [],
      recoveryCommands: [],
      warnings: [],
    })).toThrow("must agree with assessment blockers");
  });

  test("service actions follow their operational order", () => {
    const assessment = fixture("existing-git-vault");
    expect(() => validateSetupPlan({
      schema: SETUP_PLAN_SCHEMA,
      status: "ready",
      assessment,
      writes: [],
      commits: [],
      serviceActions: [
        { kind: "select-home-vault", vaultPath: "/Users/example/Vault" },
        { kind: "install-home", artifactId: ARTIFACT },
      ],
      optionalSteps: [],
      recoveryCommands: [],
      warnings: [],
    })).toThrow("canonical operation order");
  });

  test("Home install and start actions share one assessed service label", () => {
    const assessment = fixture("existing-git-vault");
    expect(() => validateVaultAssessment({
      ...assessment,
      actions: assessment.actions.map((action) => action.kind === "start-home" ?
        { ...action, serviceLabel: "com.dome.home.other-vault" } : action),
    })).toThrow("must use one service label");
  });

  test("plan writes cannot drift from assessed content-scope bytes", () => {
    const assessment = fixture("existing-git-vault");
    const writes: Array<SetupPlan["writes"][number]> = [];
    for (const action of assessment.actions) {
      if (action.kind === "write-scaffold-file") writes.push({
        id: action.id,
        path: action.path,
        operation: "create-file",
        bytes: action.bytes,
        sha256: action.sha256,
        mode: action.mode,
        ifMissing: action.ifMissing,
      });
      if (action.kind === "set-content-scope") writes.push({
        id: action.id,
        ...action.write,
        bytes: action.write.bytes + 1,
      });
    }
    const serviceActions: Array<SetupPlan["serviceActions"][number]> = [];
    for (const action of assessment.actions) {
      if (action.kind === "install-home") serviceActions.push({ kind: action.kind, artifactId: action.artifactId });
      if (action.kind === "select-home-vault") serviceActions.push({ kind: action.kind, vaultPath: action.vaultPath });
      if (action.kind === "install-home-service") serviceActions.push({
        kind: action.kind, serviceLabel: action.serviceLabel, ifMissing: action.ifMissing,
      });
      if (action.kind === "start-home") serviceActions.push({ kind: action.kind, serviceLabel: action.serviceLabel });
    }
    expect(() => validateSetupPlan({
      schema: SETUP_PLAN_SCHEMA,
      status: "ready",
      assessment,
      writes,
      commits: [{
        kind: "configuration",
        message: "Configure Dome",
        paths: [...new Set(writes.map((write) => write.path))].sort(),
      }],
      serviceActions,
      optionalSteps: [],
      recoveryCommands: [],
      warnings: [],
    })).toThrow("must bind content-scope to its exact vault-config write");
  });
});
