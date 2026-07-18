import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { commit, initRepo, log, statusMatrix } from "../../src/git";

const HEAD = "1".repeat(40);
const ARTIFACT = "2".repeat(64);
const MANIFEST = "3".repeat(64);
const scope = { version: 1 as const, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] };
const scaffold = {
  agentsOrientation: "# Dome vault\n",
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

describe("applySetupPlan", () => {
  for (const kind of ["new", "non-git", "git"] as const) {
    test(`adapts a ${kind} vault with exact commits and an idempotent retry`, async () => {
      const target = await fixture(kind);
      const plan = await planFor(target);
      const consent = createSetupConsent(plan);
      const result = await applier()(plan, consent);
      expect(result.status).toBe("completed");
      expect(await readFile(join(target, ".dome/config.yaml"), "utf8")).toBe(scaffold.vaultConfig);
      expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
      const messages = (await log({ path: target, depth: 4 })).map((row) => row.commit.message);
      expect(messages.some((message) => message.includes("Dome-Setup-Phase: configuration"))).toBe(true);
      expect(messages.some((message) => message.includes("Dome-Setup-Phase: baseline"))).toBe(kind === "non-git");
      expect((await applier()(plan, consent)).status).toBe("completed");
    });
  }

  const boundaries: Record<"new" | "non-git" | "git", ReadonlyArray<SetupDurableBoundary>> = {
    new: SETUP_DURABLE_BOUNDARIES.filter((row) => row !== "owner-baseline-committed"),
    "non-git": SETUP_DURABLE_BOUNDARIES.filter((row) => row !== "vault-directory-created"),
    git: SETUP_DURABLE_BOUNDARIES.filter((row) =>
      row !== "vault-directory-created" && row !== "git-initialized" && row !== "owner-baseline-committed"),
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
});
