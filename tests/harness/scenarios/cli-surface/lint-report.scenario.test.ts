// scenarios/cli-surface/lint-report.scenario.test.ts
//
// `dome lint` renders a source-backed adopted-state hygiene report. The
// command is a first-class wrapper over a view-phase bundle processor.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome lint reports diagnostics and deterministic checks",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.lint"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/bad.md": "# Bad\n\nThis links to [[missing-page]].\n",
        "wiki/empty.md": "",
      },
      message: "add lint findings",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli(["lint"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("DOME lint");
    expect(text.stdout).toContain("status   pass | fail-on error");
    expect(text.stdout).toContain("dome.markdown.broken-wikilink");
    expect(text.stdout).toContain("dome.lint.empty-markdown-file");
    expect(text.stdout).toContain("wiki/bad.md");
    expect(text.stdout).toContain("wiki/empty.md");

    const strict = await h.runCli(["lint", "--fail-on", "warning", "--json"]);
    expect(strict.exitCode).toBe(1);
    expect(strict.stderr).toBe("");
    const payload = JSON.parse(strict.stdout) as {
      readonly status: string;
      readonly failOn: string;
      readonly checked: { readonly markdownFiles: number };
      readonly counts: { readonly total: number; readonly warning: number };
      readonly issues: ReadonlyArray<{ readonly code: string }>;
    };
    expect(payload.status).toBe("fail");
    expect(payload.failOn).toBe("warning");
    expect(payload.checked.markdownFiles).toBe(2);
    expect(payload.counts.warning).toBeGreaterThanOrEqual(2);
    expect(payload.counts.total).toBe(payload.issues.length);
    expect(payload.issues.some((issue) =>
      issue.code === "dome.lint.empty-markdown-file"
    )).toBe(true);

    const never = await h.runCli(["lint", "--fail-on", "never"]);
    expect(never.exitCode).toBe(0);
  },
);
