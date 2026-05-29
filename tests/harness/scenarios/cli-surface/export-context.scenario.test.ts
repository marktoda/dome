// scenarios/cli-surface/export-context.scenario.test.ts
//
// `dome export-context` packages adopted search matches and related facts into
// a portable markdown packet for cross-session handoff.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome export-context returns source-backed markdown packet",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph", "dome.search"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/project-alpha.md":
          "---\n" +
          "type: project\n" +
          "tags:\n" +
          "  - strategy\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The alpha launch ownership model assigns platform runtime to Danny.\n",
        "wiki/project-beta.md":
          "---\n" +
          "type: project\n" +
          "---\n" +
          "# Project Beta\n\n" +
          "The beta launch has a different staffing plan.\n",
      },
      message: "add exportable context",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli(["export-context", "alpha launch"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("# Dome Context: alpha launch");
    expect(text.stdout).toContain("wiki/project-alpha.md");
    expect(text.stdout).toContain("alpha launch ownership model");
    expect(text.stdout).toContain("SourceRefs:");
    expect(text.stdout).toContain("dome.graph.tagged");

    const json = await h.runCli([
      "export-context",
      "alpha launch",
      "--json",
      "--limit",
      "3",
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");

    const payload = JSON.parse(json.stdout) as {
      readonly topic: string;
      readonly limit: number;
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly title: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        readonly facts: ReadonlyArray<{ readonly predicate: string }>;
      }>;
    };

    expect(payload.topic).toBe("alpha launch");
    expect(payload.limit).toBe(3);
    expect(payload.markdown).toContain("# Dome Context: alpha launch");
    const alpha = payload.entries.find(
      (entry) => entry.path === "wiki/project-alpha.md",
    );
    expect(alpha?.title).toBe("Project Alpha");
    expect(alpha?.sourceRefs[0]?.path).toBe("wiki/project-alpha.md");
    expect(alpha?.facts.some((fact) => fact.predicate === "dome.graph.tagged"))
      .toBe(true);
  },
);
