// The compatibility init surface is intentionally narrow: canonical setup
// owns all mutation, while removed legacy mutation flags fail in Commander.

import { expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scenario } from "../../index";
import { runCli } from "../../../../src/cli";
import { currentSha, readBlob } from "../../../../src/git";

scenario(
  {
    name: "cli-surface: dome init is a narrow alias over canonical setup",
    tags: [{ kind: "group", group: "cli-surface" }],
  },
  async () => {
    const target = await realpath(mkdtempSync(join(tmpdir(), "dome-init-boot-")));
    try {
      const init = await runCliCaptured(["init", target]);
      expect(init.exitCode).toBe(0);
      expect(init.stdout).toContain("Dome setup complete");
      expect(init.stderr).toBe("");

      expect(existsSync(join(target, ".git"))).toBe(true);
      expect(existsSync(join(target, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
      expect(existsSync(join(target, ".gitignore"))).toBe(true);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(target, "notes"))).toBe(false);
      expect(existsSync(join(target, "inbox"))).toBe(false);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      const claude = await readFile(join(target, "CLAUDE.md"), "utf8");
      expect(claude).toContain("@AGENTS.md");
      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head === null) throw new Error("expected dome init to create HEAD");
      expect(await readBlob({ path: target, commit: head, filepath: "AGENTS.md" })).toBe(agents);
      expect(await readBlob({ path: target, commit: head, filepath: "CLAUDE.md" })).toBe(claude);

      const sync = await runCliCaptured(["sync", "--vault", target, "--json"]);
      expect(sync.exitCode).toBe(0);
      const payload = JSON.parse(sync.stdout) as { readonly status: string };
      expect(["adopted", "in-sync"]).toContain(payload.status);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  },
);

for (const flag of ["--refresh-config", "--refresh-instructions"] as const) {
  scenario(
    {
      name: `cli-surface: dome init rejects retired ${flag}`,
      tags: [{ kind: "group", group: "cli-surface" }],
    },
    async () => {
      const target = mkdtempSync(join(tmpdir(), "dome-init-retired-"));
      const ownerPath = join(target, "Owner.md");
      try {
        await writeFile(ownerPath, "owner bytes\n");
        const before = await readFile(ownerPath, "utf8");
        const init = await runCliCaptured(["init", target, flag]);
        expect(init.exitCode).toBe(64);
        expect(init.stderr).toContain(`unknown option '${flag}'`);
        expect(await readFile(ownerPath, "utf8")).toBe(before);
        expect(existsSync(join(target, ".git"))).toBe(false);
        expect(existsSync(join(target, ".dome"))).toBe(false);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
  );
}

async function runCliCaptured(args: string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => stdout.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => stderr.push(parts.map(String).join(" "));
  try {
    return { exitCode: await runCli(args), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
