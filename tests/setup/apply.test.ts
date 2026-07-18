import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SETUP_DURABLE_BOUNDARIES,
  createSetupPlanApplier,
  failSetupAfter,
  type SetupDurableBoundary,
} from "../../src/setup/apply";
import { compileSetupPlan, type SetupCompilerInput } from "../../src/setup/compiler";
import { createSetupConsent } from "../../src/setup/consent";
import { inspectSetupVaultSource } from "../../src/setup/vault-inspector";
import {
  commit,
  currentBranch,
  currentSha,
  initRepo,
  listTreeEntriesAtCommit,
  log,
  readBlob,
  readBlobBytes,
  statusMatrix,
} from "../../src/git";

const HEAD = "1".repeat(40);
const ARTIFACT = "2".repeat(64);
const MANIFEST = "3".repeat(64);
const scope = { version: 1 as const, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] };
const scaffold = {
  agentsOrientation: "# Dome vault\n",
  claudeOrientation: "@AGENTS.md\n",
  gitignore: ".dome/state/\n",
  vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
  contentScopeConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function evidence(target: string): Promise<SetupCompilerInput> {
  return {
    source: await inspectSetupVaultSource(target),
    host: { platform: "linux", architecture: "x64" },
    prerequisites: { bun: "1.2.13", git: "2.50.1" },
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
    installedHome: {
      state: "absent", artifactId: null, productVersion: null, buildCommit: null,
      manifestSha256: null, selectedVaultPath: null,
    },
    contentScope: scope,
    scaffold,
  };
}

function applier(afterBoundary?: (boundary: SetupDurableBoundary) => Promise<void>) {
  return createSetupPlanApplier({
    discovery: { contentScope: scope, scaffold },
    discover: async (target) => evidence(target),
    ...(afterBoundary === undefined ? {} : { afterBoundary }),
  });
}

async function fixture(kind: "new" | "non-git" | "git"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-setup-apply-")));
  roots.push(root);
  const target = kind === "new" ? join(root, "Vault") : root;
  if (kind !== "new") await writeFile(join(target, "Owner.md"), "# Owner\n");
  if (kind === "git") {
    await initRepo(target);
    await commit({ path: target, files: ["Owner.md"], message: "Owner history" });
  }
  return target;
}

async function planFor(target: string) {
  const plan = compileSetupPlan(await evidence(target));
  expect(plan.status, JSON.stringify(plan.assessment.blockers)).toBe("ready");
  return plan;
}

async function publicationWitness(
  target: string,
  digest: string,
  path: string,
  phase: "prepared" | "published" = "prepared",
): Promise<{ witnessPath: string; candidatePath: string }> {
  const directory = join(target, ".dome/state/setup", digest);
  for (const name of await readdir(directory)) {
    if (!name.endsWith(`.${phase}.json`)) continue;
    const witnessPath = join(directory, name);
    const parsed = JSON.parse(await readFile(witnessPath, "utf8")) as {
      path?: unknown;
      candidatePath?: unknown;
    };
    if (parsed.path === path && typeof parsed.candidatePath === "string") {
      return { witnessPath, candidatePath: join(target, parsed.candidatePath) };
    }
  }
  throw new Error(`missing ${phase} publication witness for ${path}`);
}

async function crashPublicationProcess(
  target: string,
  plan: Awaited<ReturnType<typeof planFor>>,
  transition: "candidate-durable" | "destination-linked-durable",
): Promise<number> {
  const carrier = await realpath(await mkdtemp(join(tmpdir(), "dome-setup-crash-payload-")));
  roots.push(carrier);
  const payloadPath = join(carrier, "payload.json");
  await writeFile(payloadPath, JSON.stringify({
    plan,
    consent: createSetupConsent(plan),
    scaffold,
    compilerInput: await evidence(target),
  }));
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures/setup-publication-crash.ts"),
    payloadPath,
    transition,
  ], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  if (exitCode !== 86) throw new Error(`crash fixture exited ${exitCode}: ${stderr}`);
  return exitCode;
}

describe("applySetupPlan", () => {
  for (const kind of ["new", "non-git", "git"] as const) {
    test(`adapts a ${kind} vault with exact commits and an idempotent retry`, async () => {
      const target = await fixture(kind);
      const plan = await planFor(target);
      const consent = createSetupConsent(plan);
      const result = await applier()(plan, consent);
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(await readFile(join(target, ".dome/config.yaml"), "utf8")).toBe(scaffold.vaultConfig);
      expect(await readFile(join(target, "CLAUDE.md"), "utf8")).toBe(scaffold.claudeOrientation);
      expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
      const messages = (await log({ path: target, depth: 4 })).map((row) => row.commit.message);
      expect(messages.some((message) => message.includes("Dome-Setup-Phase: configuration"))).toBe(true);
      expect(messages.some((message) => message.includes("Dome-Setup-Phase: baseline"))).toBe(kind === "non-git");
      expect((await applier()(plan, consent)).status).toBe("completed");
    });
  }

  const boundaries: Record<"new" | "non-git" | "git", ReadonlyArray<SetupDurableBoundary>> = {
    new: SETUP_DURABLE_BOUNDARIES.filter((row) =>
      row !== "owner-baseline-ref-advanced" && row !== "owner-baseline-committed"),
    "non-git": SETUP_DURABLE_BOUNDARIES.filter((row) => row !== "vault-directory-created"),
    git: SETUP_DURABLE_BOUNDARIES.filter((row) =>
      row !== "vault-directory-created" && row !== "git-initialized" &&
      row !== "owner-baseline-ref-advanced" && row !== "owner-baseline-committed"),
  };

  for (const kind of ["new", "non-git", "git"] as const) {
    for (const boundary of boundaries[kind]) {
      test(`converges ${kind} after ${boundary}`, async () => {
        const target = await fixture(kind);
        const plan = await planFor(target);
        const consent = createSetupConsent(plan);
        await expect(applier(failSetupAfter(boundary))(plan, consent)).rejects.toThrow(`after ${boundary}`);
        const result = await applier()(plan, consent);
        expect(result.status).toBe("completed");
        expect((await log({ path: target, depth: 5 }))
          .filter((row) => row.commit.message.includes("Dome-Setup-Phase: configuration"))).toHaveLength(1);
      });
    }
  }

  test("returns stale before the first write when owner evidence changes", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    await writeFile(join(target, "Owner.md"), "# Changed\n");
    const result = await applier()(plan, createSetupConsent(plan));
    expect(result.status).toBe("stale");
    expect(await Bun.file(join(target, ".dome/config.yaml")).exists()).toBe(false);
  });

  test("preflights the native host before discovery or mutation", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    let discoveries = 0;
    const apply = createSetupPlanApplier({
      discovery: { contentScope: scope, scaffold },
      discover: async () => { discoveries += 1; return evidence(target); },
      preflightPlatform: () => { throw new Error("unsupported setup host"); },
    });

    const result = await apply(plan, createSetupConsent(plan));
    expect(result).toMatchObject({ status: "blocked", recovery: { code: "mutation-conflict" } });
    expect(discoveries).toBe(0);
    expect(await Bun.file(join(target, ".dome/config.yaml")).exists()).toBeFalse();
  });

  test("blocks a retry when ignored owner evidence changes inside a partial transaction", async () => {
    const target = await fixture("git");
    await writeFile(join(target, ".gitignore"), "secret.txt\n");
    await writeFile(join(target, "secret.txt"), "alpha\n");
    await commit({ path: target, files: [".gitignore"], message: "Ignore private owner file" });
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("scaffold-directories-created"))(plan, consent)).rejects.toThrow();
    await Bun.sleep(10);
    await writeFile(join(target, "secret.txt"), "bravo\n");
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(result.status === "blocked" && result.recovery.code).toBe("mutation-conflict");
    expect(await Bun.file(join(target, ".dome/config.yaml")).exists()).toBe(false);
  });

  test("never stages owner drift after Git initialization", async () => {
    const target = await fixture("non-git");
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "git-initialized") await writeFile(join(target, "Owner.md"), "# raced owner\n");
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBeNull();
  });

  test("refuses a renamed unborn branch before the owner baseline", async () => {
    const target = await fixture("non-git");
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "git-initialized") {
        const process = Bun.spawn(["git", "-C", target, "branch", "-m", "raced"], { stderr: "pipe" });
        expect(await process.exited).toBe(0);
      }
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentBranch(target)).toBe("raced");
    expect(await currentSha(target)).toBeNull();
  });

  test("never stages a tracked owner scaffold path changed after directory creation", async () => {
    const target = await fixture("git");
    await writeFile(join(target, "AGENTS.md"), "# owner orientation\n");
    await commit({ path: target, files: ["AGENTS.md"], message: "Owner orientation" });
    const approvedHead = await currentSha(target);
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "scaffold-directories-created") await writeFile(join(target, "AGENTS.md"), "# raced orientation\n");
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(approvedHead);
    expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe("# raced orientation\n");
    expect(await readBlob({ path: target, commit: approvedHead!, filepath: "AGENTS.md" })).toBe("# owner orientation\n");
  });

  test("refuses post-publication config drift instead of folding it into the commit", async () => {
    const target = await fixture("git");
    const approvedHead = await currentSha(target);
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "content-scope-written") {
        await writeFile(join(target, ".dome/config.yaml"), `${scaffold.vaultConfig}# raced\n`);
      }
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(approvedHead);
  });

  test("refuses to commit setup writes after the owner switches branches", async () => {
    const target = await fixture("git");
    const approvedHead = await currentSha(target);
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "content-scope-written") {
        const process = Bun.spawn(["git", "-C", target, "switch", "-c", "raced"], { stderr: "pipe" });
        expect(await process.exited).toBe(0);
      }
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentBranch(target)).toBe("raced");
    expect(await currentSha(target)).toBe(approvedHead);
  });

  test("holds the real index lock through ref advance and releases it on refusal", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    let addExit = 0;
    const first = await applier(async (boundary) => {
      if (boundary !== "configuration-ref-advanced") return;
      await writeFile(join(target, "Owner.md"), "# owner staging attempt\n");
      const add = Bun.spawn(["git", "-C", target, "add", "--", "Owner.md"], { stderr: "pipe" });
      addExit = await add.exited;
      await writeFile(join(target, "Owner.md"), "# Owner\n");
      throw new Error("injected after ref advance");
    })(plan, consent);
    expect(first.status).toBe("blocked");
    expect(addExit).not.toBe(0);

    const retry = await applier()(plan, consent);
    expect(retry.status).toBe("blocked");
    expect(await Bun.file(join(target, ".git/index.lock")).exists()).toBeFalse();
  });

  test("refuses an identical concurrent create after preparing Dome's config", async () => {
    const target = await fixture("git");
    const approvedHead = await currentSha(target);
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "content-scope-prepared") {
        await writeFile(join(target, ".dome/config.yaml"), scaffold.vaultConfig);
      }
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(approvedHead);
  });

  test("refuses owner config drift after preparing the scope overlay", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome"));
    const configPath = join(target, ".dome/config.yaml");
    await writeFile(configPath, "# owner comment\ngrants: standard\n");
    await commit({ path: target, files: [".dome/config.yaml"], message: "Owner config" });
    const approvedHead = await currentSha(target);
    const plan = await planFor(target);
    const result = await applier(async (boundary) => {
      if (boundary === "content-scope-prepared") {
        await writeFile(configPath, "# raced owner config\ngrants: standard\n");
      }
    })(plan, createSetupConsent(plan));
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(approvedHead);
    expect(await readFile(configPath, "utf8")).toContain("raced owner config");
  });

  test("refuses a candidate inode swap before publishing its witness", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    const result = await applier(async (boundary) => {
      if (boundary !== "agents-orientation-prepared") return;
      const { candidatePath } = await publicationWitness(target, consent.planSha256, "AGENTS.md");
      await unlink(candidatePath);
      await writeFile(candidatePath, scaffold.agentsOrientation);
    })(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(plan.assessment.revision.head);
    expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(scaffold.agentsOrientation);
    await expect(publicationWitness(target, consent.planSha256, "AGENTS.md", "published")).rejects.toThrow();
  });

  test("rejects a forged marker commit without scanning older history", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await writeFile(join(target, "Owner.md"), "# forged\n");
    await commit({
      path: target,
      files: ["Owner.md"],
      message: `Forged subject\n\nDome-Setup-Plan: ${consent.planSha256}\nDome-Setup-Phase: configuration`,
      author: { name: "Mallory", email: "mallory@example.test" },
    });
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await Bun.file(join(target, ".dome/config.yaml")).exists()).toBe(false);
  });

  test("rejects partial prepared bytes and publishes no destination", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("agents-orientation-prepared"))(plan, consent)).rejects.toThrow();
    const { candidatePath } = await publicationWitness(target, consent.planSha256, "AGENTS.md");
    await unlink(candidatePath);
    await writeFile(candidatePath, "partial");
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await Bun.file(join(target, "AGENTS.md")).exists()).toBe(false);
  });

  test("rejects exact final scaffold bytes without a published witness", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("scaffold-directories-created"))(plan, consent)).rejects.toThrow();
    await writeFile(join(target, "AGENTS.md"), scaffold.agentsOrientation);
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(plan.assessment.revision.head);
  });

  test("refuses completed final bytes when their durable witness is removed", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    const complete = await applier()(plan, consent);
    expect(complete.status).toBe("completed");
    const witnessDirectory = join(target, ".dome/state/setup", consent.planSha256);
    const published = (await readdir(witnessDirectory)).find((name) => name.endsWith(".published.json"));
    expect(published).toBeDefined();
    await unlink(join(witnessDirectory, published!));
    const retry = await applier()(plan, consent);
    expect(retry.status).toBe("blocked");
    expect(retry.status === "blocked" && retry.recovery.code).toBe("mutation-conflict");
  });

  test("rejects a mode-changed final even with Dome's published witness", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("agents-orientation-published"))(plan, consent)).rejects.toThrow();
    await chmod(join(target, "AGENTS.md"), 0o600);
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect((await stat(join(target, "AGENTS.md"))).mode & 0o777).toBe(0o600);
  });

  test("rejects exact scope-overlay bytes without a published witness", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome"));
    const configPath = join(target, ".dome/config.yaml");
    await writeFile(configPath, "# owner\ngrants: standard\n");
    await commit({ path: target, files: [".dome/config.yaml"], message: "Owner config" });
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("content-scope-prepared"))(plan, consent)).rejects.toThrow();
    const { candidatePath } = await publicationWitness(
      target,
      consent.planSha256,
      ".dome/content-scope.yaml",
    );
    const exactOverlay = await readFile(candidatePath, "utf8");
    await unlink(candidatePath);
    await writeFile(join(target, ".dome/content-scope.yaml"), exactOverlay);
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(plan.assessment.revision.head);
  });

  test("blocks oversized publication witnesses before parsing them", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("agents-orientation-prepared"))(plan, consent)).rejects.toThrow();
    const { witnessPath } = await publicationWitness(target, consent.planSha256, "AGENTS.md");
    await writeFile(witnessPath, "x".repeat(4_097));
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await Bun.file(join(target, "AGENTS.md")).exists()).toBe(false);
  });

  test("blocks oversized owned candidates without loading their bytes", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("agents-orientation-prepared"))(plan, consent)).rejects.toThrow();
    const { candidatePath } = await publicationWitness(target, consent.planSha256, "AGENTS.md");
    await unlink(candidatePath);
    await writeFile(candidatePath, "x".repeat(64 * 1024));
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await Bun.file(join(target, "AGENTS.md")).exists()).toBe(false);
  });

  test("rejects an exact-byte final replacement after published witness", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("agents-orientation-published"))(plan, consent)).rejects.toThrow();
    await unlink(join(target, "AGENTS.md"));
    await writeFile(join(target, "AGENTS.md"), scaffold.agentsOrientation);
    const result = await applier()(plan, consent);
    expect(result.status).toBe("blocked");
    expect(await currentSha(target)).toBe(plan.assessment.revision.head);
  });

  test("retries after a real process exit between durable candidate and prepared witness", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    expect(await crashPublicationProcess(target, plan, "candidate-durable")).toBe(86);
    const candidateDirectory = join(target, ".dome/state/setup", consent.planSha256, "candidates");
    const orphaned = await readdir(candidateDirectory);
    expect(orphaned).toHaveLength(1);
    await writeFile(join(candidateDirectory, "foreign.keep"), "owner debris\n");
    const result = await applier()(plan, consent);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect((await readdir(candidateDirectory)).sort()).toEqual([...orphaned, "foreign.keep"].sort());
    expect(await readFile(join(candidateDirectory, "foreign.keep"), "utf8")).toBe("owner debris\n");
  });

  test("retries after a real process exit between durable link and published witness", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    expect(await crashPublicationProcess(target, plan, "destination-linked-durable")).toBe(86);
    expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(scaffold.agentsOrientation);
    const prepared = await publicationWitness(target, consent.planSha256, "AGENTS.md");
    const result = await applier()(plan, consent);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(await Bun.file(prepared.candidatePath).exists()).toBe(false);
    await publicationWitness(target, consent.planSha256, "AGENTS.md", "published");
  });

  test("replays destination durability after a post-link pre-fsync failure", async () => {
    const target = await fixture("git");
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("agents-orientation-published"))(plan, consent)).rejects.toThrow();
    expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(scaffold.agentsOrientation);
    const result = await applier()(plan, consent);
    expect(result.status, JSON.stringify(result)).toBe("completed");
  });

  test("replays scope-overlay durability after a post-link pre-fsync failure", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome"));
    const configPath = join(target, ".dome/config.yaml");
    await writeFile(configPath, "# owner\ngrants: standard\n");
    await chmod(configPath, 0o600);
    await commit({ path: target, files: [".dome/config.yaml"], message: "Owner config" });
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);
    await expect(applier(failSetupAfter("content-scope-published"))(plan, consent)).rejects.toThrow();
    expect(await readFile(join(target, ".dome/content-scope.yaml"), "utf8")).toBe(scaffold.contentScopeConfig);
    const result = await applier()(plan, consent);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test("keeps existing config bytes, inode, and mode identical while adding the scope overlay", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome"));
    const configPath = join(target, ".dome/config.yaml");
    await writeFile(configPath, "# owner comment\ngrants: standard\n");
    await chmod(configPath, 0o600);
    await commit({ path: target, files: [".dome/config.yaml"], message: "Owner config" });
    const before = await stat(configPath);
    const ownerBytes = await readFile(configPath, "utf8");
    const plan = await planFor(target);
    const result = await applier()(plan, createSetupConsent(plan));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const after = await stat(configPath);
    expect(await readFile(configPath, "utf8")).toBe(ownerBytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(await readFile(join(target, ".dome/content-scope.yaml"), "utf8")).toBe(scaffold.contentScopeConfig);
  });

  test("recovers an interrupted scope-overlay publication without touching owner config", async () => {
    const target = await fixture("git");
    await mkdir(join(target, ".dome"));
    const configPath = join(target, ".dome/config.yaml");
    await writeFile(configPath, "# owner comment\ngrants: standard\n");
    await chmod(configPath, 0o600);
    await commit({ path: target, files: [".dome/config.yaml"], message: "Owner config" });
    const before = await stat(configPath);
    const plan = await planFor(target);
    const consent = createSetupConsent(plan);

    await expect(applier(failSetupAfter("content-scope-prepared"))(plan, consent)).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe("# owner comment\ngrants: standard\n");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    const result = await applier()(plan, consent);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const after = await stat(configPath);
    expect(await readFile(configPath, "utf8")).toBe("# owner comment\ngrants: standard\n");
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await readFile(join(target, ".dome/content-scope.yaml"), "utf8")).toBe(scaffold.contentScopeConfig);
  });

  test("preserves binary bytes and executable modes in the exact owner baseline", async () => {
    const target = await fixture("non-git");
    const binary = Uint8Array.from([0, 255, 128, 10, 13]);
    await writeFile(join(target, "binary.bin"), binary);
    await writeFile(join(target, "tool.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(target, "tool.sh"), 0o755);
    const plan = await planFor(target);
    const result = await applier()(plan, createSetupConsent(plan));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const baseline = result.status === "completed" ? result.commits.baseline! : "";
    expect(await readBlobBytes({ path: target, commit: baseline, filepath: "binary.bin" })).toEqual(binary);
    expect((await listTreeEntriesAtCommit(target, baseline)).find((row) => row.path === "tool.sh")?.mode).toBe("100755");
  });
});
