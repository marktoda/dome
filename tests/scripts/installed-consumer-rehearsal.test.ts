import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfigYaml } from "../../src/cli/default-vault-config";
import {
  CLAUDE_MD_TEMPLATE,
  DEFAULT_AGENTS_MD,
} from "../../src/cli/commands/init-templates";
import { verifyInstalledConsumerWorkflow } from "../../scripts/installed-consumer-rehearsal";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed consumer rehearsal", () => {
  test("runs the packed CLI through minimal init, shipped bundles, sync, and reopen", async () => {
    const fixture = await consumerFixture();
    const commands: ReadonlyArray<string>[] = [];
    const evidence = await verifyInstalledConsumerWorkflow({
      ...fixture,
      env: Object.freeze({}),
      run: async (command) => {
        commands.push([...command]);
        if (command[1] === "init") {
          expect(command).toEqual([fixture.domeBin, "init", join(fixture.workspace, "external-vault")]);
          await materializeMinimalVault(command[2]!);
          return { stdout: "initialized\n" };
        }
        if (command[1] === "inspect") {
          return { stdout: JSON.stringify([{ bundle: "dome.markdown", loaded: true }]) };
        }
        if (command[1] === "status") {
          return { stdout: JSON.stringify({ head: "h".repeat(40), adopted: "a".repeat(40) }) };
        }
        return { stdout: "" };
      },
    });
    expect(evidence.scaffold).toEqual({
      canonicalAgents: true,
      canonicalClaude: true,
      canonicalConfig: true,
      installedAssets: true,
      bundlesResolved: true,
    });
    expect(commands.map((command) => command.slice(1, 3))).toEqual([
      ["init", join(fixture.workspace, "external-vault")],
      ["sync", "--vault"],
      ["inspect", "bundles"],
      ["status", "--vault"],
      ["status", "--vault"],
    ]);
    expect(commands.flat()).not.toContain("--with-model-provider");
    expect(commands.flat()).not.toContain("--with-source");
  });

  test("rejects noncanonical installed init output before sync", async () => {
    const fixture = await consumerFixture();
    const commands: ReadonlyArray<string>[] = [];
    await expect(verifyInstalledConsumerWorkflow({
      ...fixture,
      env: Object.freeze({}),
      run: async (command) => {
        commands.push([...command]);
        if (command[1] === "init") {
          await materializeMinimalVault(command[2]!);
          await writeFile(join(command[2]!, "CLAUDE.md"), "not canonical\n");
        }
        return { stdout: "" };
      },
    })).rejects.toThrow("noncanonical CLAUDE.md");
    expect(commands).toHaveLength(1);
  });
});

async function consumerFixture(): Promise<Readonly<{
  domeBin: string;
  installedRoot: string;
  workspace: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), "dome-installed-consumer-"));
  roots.push(root);
  const installedRoot = join(root, "installed");
  const workspace = join(root, "workspace");
  const domeBin = join(root, "bin", "dome");
  await mkdir(join(installedRoot, "assets", "extensions", "dome.markdown"), { recursive: true });
  await mkdir(join(installedRoot, "assets", "model-providers"), { recursive: true });
  await mkdir(join(installedRoot, "assets", "source-handlers"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(installedRoot, "assets", "extensions", "dome.markdown", "manifest.yaml"), "id: dome.markdown\n");
  await writeFile(join(installedRoot, "assets", "model-providers", "anthropic.ts"), "export {};\n");
  await writeFile(join(installedRoot, "assets", "source-handlers", "claude-slack.sh"), "#!/bin/sh\n");
  return Object.freeze({ domeBin, installedRoot, workspace });
}

async function materializeMinimalVault(vault: string): Promise<void> {
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await writeFile(join(vault, "AGENTS.md"), DEFAULT_AGENTS_MD);
  await writeFile(join(vault, "CLAUDE.md"), CLAUDE_MD_TEMPLATE);
  await writeFile(join(vault, ".dome", "config.yaml"), defaultConfigYaml());
}
