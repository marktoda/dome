// scenarios/cli-surface/init-claude-boot.scenario.test.ts
//
// `dome init` is the Claude Code boot path. A freshly initialized vault
// must contain the orientation files, git scaffold, and enough CLI wiring
// for the user or Claude to immediately run the compiler catch-up path.

import { expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      expect(existsSync(join(target, "notes"))).toBe(true);
      expect(existsSync(join(target, "inbox", "raw"))).toBe(true);
      expect(existsSync(join(target, "inbox", "processed"))).toBe(true);
      expect(existsSync(join(target, ".gitignore"))).toBe(true);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      const claude = await readFile(join(target, "CLAUDE.md"), "utf8");
      const gitignore = await readFile(join(target, ".gitignore"), "utf8");

      expect(claude.startsWith("@AGENTS.md")).toBe(true);
      expect(claude).toContain("dome status --json");
      expect(claude).toContain("next_actions");
      expect(claude).toContain("dome sync --json");
      expect(claude).toContain("dome check --json");
      expect(claude).toContain("dome resolve <id> <value>");
      expect(claude).not.toContain("only use `dome status`");
      expect(agents).toContain("## Daily loop");
      expect(agents).toContain("Dome works at the git commit boundary");
      expect(agents).toContain("dome status --json");
      expect(agents).toContain("attention_required");
      expect(agents).toContain("next_actions");
      expect(agents).toContain("dome check --json");
      expect(agents).toContain("dome sync --json");
      expect(agents).toContain("dome resolve <id> <value>");
      expect(agents).toContain("dome today");
      expect(agents).toContain("dome export-context <topic>");
      expect(agents).toContain("Advanced/debug commands");
      expect(agents).toContain("dome inspect <subject>");
      expect(agents).toContain("dome inspect bundles --json");
      expect(agents).toContain("inbox/raw/");
      expect(agents).toContain("dome.intake");
      expect(agents).toContain('model: "ready"');
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

scenario(
  {
    name: "cli-surface: dome init refreshes stale first-party grants",
    tags: [{ kind: "group", group: "cli-surface" }],
  },
  async () => {
    const target = mkdtempSync(join(tmpdir(), "dome-init-refresh-"));
    try {
      await mkdir(join(target, ".dome"), { recursive: true });
      await writeFile(
        join(target, ".dome", "config.yaml"),
        "extensions:\n" +
          "  dome.lint:\n" +
          "    enabled: true\n" +
          "  dome.markdown:\n" +
          "    enabled: true\n" +
          "    grant:\n" +
          "      read:\n" +
          "        - \"**/*.md\"\n",
        "utf8",
      );

      const init = await runCliCaptured(["init", target, "--refresh-config"]);
      expect(init.exitCode).toBe(0);
      expect(init.stderr).toBe("");
      expect(init.stdout).toContain(".dome/config.yaml:       updated");

      const doctor = await runCliCaptured([
        "doctor",
        "--vault",
        target,
        "--json",
      ]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stderr).toBe("");
      const report = JSON.parse(doctor.stdout) as {
        readonly status: string;
        readonly summary: { readonly capabilityGrantGaps: number };
      };
      expect(report.status).toBe("ok");
      expect(report.summary.capabilityGrantGaps).toBe(0);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  },
);

scenario(
  {
    name: "cli-surface: dome init refreshes stale orientation shims",
    tags: [{ kind: "group", group: "cli-surface" }],
  },
  async () => {
    const target = mkdtempSync(join(tmpdir(), "dome-init-instructions-"));
    try {
      await writeFile(
        join(target, "AGENTS.md"),
        "# Old AGENTS\n\nVault-specific instructions.\n",
        "utf8",
      );
      await writeFile(
        join(target, "CLAUDE.md"),
        "# Old CLAUDE\n\nClaude-specific instructions.\n",
        "utf8",
      );

      const init = await runCliCaptured([
        "init",
        target,
        "--refresh-instructions",
      ]);
      expect(init.exitCode).toBe(0);
      expect(init.stderr).toBe("");
      expect(init.stdout).toContain("AGENTS.md:               updated");
      expect(init.stdout).toContain("CLAUDE.md:               updated");

      const doctor = await runCliCaptured([
        "doctor",
        "--vault",
        target,
        "--json",
      ]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stderr).toBe("");
      const report = JSON.parse(doctor.stdout) as {
        readonly status: string;
        readonly summary: { readonly instructionDrift: number };
      };
      expect(report.status).toBe("ok");
      expect(report.summary.instructionDrift).toBe(0);
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
