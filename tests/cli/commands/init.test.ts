import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { defaultConfigYaml } from "../../../src/cli/default-vault-config";
import { commit, initRepo, statusMatrix } from "../../../src/git";

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

async function temporary(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-init-narrow-")));
  roots.push(root);
  return root;
}

describe("runInit narrow compatibility alias", () => {
  test("initializes a new leaf beneath an existing direct parent exclusively through canonical adaptation", async () => {
    const root = await temporary();
    const target = join(root, "work-vault");
    expect(await runInit({ path: target })).toBe(0);
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(existsSync(join(target, ".dome", "config.yaml"))).toBe(true);
    expect(existsSync(join(target, ".dome", "state"))).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
    expect(await readFile(join(target, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, "core.md"))).toBe(false);
    expect(existsSync(join(target, "wiki"))).toBe(false);
    expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
  });

  test("does not create unplanned parent containers", async () => {
    const root = await temporary();
    const target = join(root, "missing-parent", "work-vault");
    expect(await runInit({ path: target })).toBe(1);
    expect(existsSync(join(root, "missing-parent"))).toBe(false);
  });

  test("refuses a final-component symlink without mutating its empty referent", async () => {
    const root = await temporary();
    const referent = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(referent);
    await symlink(referent, alias);
    expect(await runInit({ path: alias })).toBe(1);
    expect(existsSync(join(referent, ".git"))).toBe(false);
    expect(existsSync(join(referent, ".dome"))).toBe(false);
  });

  test("freezes a symlinked parent to its canonical referent before setup", async () => {
    const root = await temporary();
    const parent = join(root, "actual-parent");
    const alias = join(root, "parent-alias");
    await mkdir(parent);
    await symlink(parent, alias);
    const target = join(alias, "Vault");
    expect(await runInit({ path: target })).toBe(0);
    expect(existsSync(join(parent, "Vault", ".git"))).toBe(true);
    expect(output.join("\n")).toContain(`Vault: ${join(parent, "Vault")}`);
  });

  test("an already-complete Dome vault is an idempotent no-op", async () => {
    const target = join(await temporary(), "Vault");
    expect(await runInit({ path: target })).toBe(0);
    const before = await readFile(join(target, ".dome", "config.yaml"), "utf8");
    output = [];
    expect(await runInit({ path: target })).toBe(0);
    expect(await readFile(join(target, ".dome", "config.yaml"), "utf8")).toBe(before);
    expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
    expect(output.join("\n")).toContain("Dome setup complete");
  });

  for (const kind of ["non-git", "git"] as const) {
    test(`refuses implicit consent for an existing ${kind} owner vault`, async () => {
      const target = await temporary();
      await writeFile(join(target, "Owner.md"), "# Owner\n");
      if (kind === "git") {
        await initRepo(target);
        await commit({ path: target, files: ["Owner.md"], message: "Owner history" });
      }
      expect(await runInit({ path: target, json: true })).toBe(1);
      const result = JSON.parse(output.join("\n")) as {
        recovery: { code: string; message: string };
      };
      expect(result.recovery.code).toBe("explicit-consent-required");
      expect(result.recovery.message).toContain("requires explicit preview");
      expect(existsSync(join(target, ".dome"))).toBe(false);
      if (kind === "non-git") expect(existsSync(join(target, ".git"))).toBe(false);
    });
  }

  test("does not implicitly migrate a configured pre-scope vault", async () => {
    const target = await temporary();
    await initRepo(target);
    await mkdir(join(target, ".dome", "state"), { recursive: true });
    await writeFile(join(target, ".dome", "config.yaml"), "grants: standard\n");
    await writeFile(join(target, "AGENTS.md"), "# Owner orientation\n");
    await writeFile(join(target, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(join(target, ".gitignore"), ".dome/state/\n");
    await commit({
      path: target,
      files: [".dome/config.yaml", "AGENTS.md", "CLAUDE.md", ".gitignore"],
      message: "Existing Dome vault",
    });
    expect(await runInit({ path: target })).toBe(1);
    expect(output.join("\n")).toContain("requires explicit preview");
    expect(existsSync(join(target, ".dome", "content-scope.yaml"))).toBe(false);
    expect((await statusMatrix(target)).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))).toEqual([]);
  });

  test("does not repair existing Dome scaffold without public setup consent", async () => {
    const target = await temporary();
    await initRepo(target);
    await mkdir(join(target, ".dome"));
    await writeFile(join(target, ".dome", "config.yaml"), defaultConfigYaml());
    await commit({ path: target, files: [".dome/config.yaml"], message: "Existing Dome config" });
    expect(await runInit({ path: target })).toBe(1);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(target, ".gitignore"))).toBe(false);
  });

  test("JSON output is the shared setup apply result", async () => {
    const target = join(await temporary(), "Vault");
    expect(await runInit({ path: target, json: true })).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      schema: "dome.setup.apply-result/v1",
      status: "completed",
      targetPath: target,
      commits: { configuration: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
  });
});
