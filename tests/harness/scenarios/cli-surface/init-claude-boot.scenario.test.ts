// scenarios/cli-surface/init-claude-boot.scenario.test.ts
//
// `dome init` is the Claude Code boot path. A freshly initialized vault
// must contain the orientation files, git scaffold, and enough CLI wiring
// for the user or Claude to immediately run the compiler catch-up path.

import { expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scenario } from "../../index";
import { runCli } from "../../../../src/cli";
import { currentSha, readBlob } from "../../../../src/git";

scenario(
  {
    name: "cli-surface: dome init creates a Claude Code-ready vault",
    tags: [{ kind: "group", group: "cli-surface" }],
  },
  async () => {
    const target = mkdtempSync(join(tmpdir(), "dome-init-boot-"));
    try {
      const init = await runCliCaptured(["init", target]);
      expect(init.exitCode).toBe(0);
      expect(init.stdout).toContain("CLAUDE.md:");
      expect(init.stderr).toBe("");

      expect(existsSync(join(target, ".git"))).toBe(true);
      expect(existsSync(join(target, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
      expect(existsSync(join(target, ".gitignore"))).toBe(true);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      const claude = await readFile(join(target, "CLAUDE.md"), "utf8");
      const gitignore = await readFile(join(target, ".gitignore"), "utf8");

      expect(claude.startsWith("@AGENTS.md")).toBe(true);
      expect(agents).toContain("## Daily loop");
      expect(agents).toContain("Dome works at the git commit boundary");
      expect(agents).toContain("dome status");
      expect(agents).toContain("dome sync");
      expect(agents).toContain("dome today");
      expect(agents).toContain("dome export-context <topic>");
      expect(agents).toContain("dome inspect questions");
      expect(agents).toContain("dome answer <id> <value>");
      expect(agents).toContain("dome rebuild");
      expect(agents).toContain(".dome/state/");
      expect(gitignore).toContain(".dome/state/");

      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head === null) throw new Error("expected dome init to create HEAD");

      expect(
        await readBlob({ path: target, commit: head, filepath: "AGENTS.md" }),
      ).toBe(agents);
      expect(
        await readBlob({ path: target, commit: head, filepath: "CLAUDE.md" }),
      ).toBe(claude);
      expect(
        await readBlob({ path: target, commit: head, filepath: ".gitignore" }),
      ).toBe(gitignore);

      const sync = await runCliCaptured(["sync", "--vault", target, "--json"]);
      expect(sync.exitCode).toBe(0);
      const payload = JSON.parse(sync.stdout) as { readonly status: string };
      expect(payload.status === "adopted" || payload.status === "in-sync").toBe(
        true,
      );
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  },
);

async function runCliCaptured(args: ReadonlyArray<string>): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const captured = { out: [] as string[], err: [] as string[] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts: unknown[]) =>
    captured.out.push(parts.map((p) => String(p)).join(" "));
  console.error = (...parts: unknown[]) =>
    captured.err.push(parts.map((p) => String(p)).join(" "));

  try {
    const exitCode = await runCli(args);
    return {
      exitCode,
      stdout: captured.out.join("\n"),
      stderr: captured.err.join("\n"),
    };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}
