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
          "type: concept\n" +
          "tags:\n" +
          "  - strategy\n" +
          "  - launch\n" +
          "  - alpha\n" +
          "  - ownership\n" +
          "  - runtime\n" +
          "  - platform\n" +
          "  - staffing\n" +
          "  - handoff\n" +
          "  - planning\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The alpha launch ownership model assigns platform runtime to Danny.\n" +
          "\n" +
          "See [[missing-alpha-owner]].\n",
        "wiki/project-alpha-copy.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The alpha launch ownership model assigns platform runtime to Danny.\n" +
          "\n" +
          "See [[missing-alpha-owner]].\n",
        "wiki/project-beta.md":
          "---\n" +
          "type: concept\n" +
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
    expect(text.stdout).toContain("more facts");
    expect(text.stdout).toContain("Diagnostics:");
    expect(text.stdout).toContain("dome.markdown.broken-wikilink");
    expect(text.stdout).toContain("Questions:");
    expect(text.stdout).toContain("resolve: dome resolve ");

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
      readonly shown: { readonly entries: number };
      readonly hasMore: { readonly entries: boolean };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly title: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
        readonly facts: ReadonlyArray<{ readonly predicate: string }>;
        readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
        readonly questions: ReadonlyArray<{
          readonly id: number;
          readonly question: string;
          readonly resolveCommand: string;
        }>;
      }>;
    };

    expect(payload.topic).toBe("alpha launch");
    expect(payload.limit).toBe(3);
    expect(payload.shown.entries).toBe(payload.entries.length);
    expect(payload.hasMore.entries).toBe(false);
    expect(payload.markdown).toContain("# Dome Context: alpha launch");
    const alpha = payload.entries.find(
      (entry) => entry.path === "wiki/project-alpha.md",
    );
    expect(alpha?.title).toBe("Project Alpha");
    expect(alpha?.sourceRefs[0]?.path).toBe("wiki/project-alpha.md");
    expect(alpha?.facts.some((fact) => fact.predicate === "dome.graph.tagged"))
      .toBe(true);
    expect((alpha?.facts.length ?? 0)).toBeGreaterThan(8);
    expect(payload.markdown).toContain(
      `... ${(alpha?.facts.length ?? 8) - 8} more facts`,
    );
    expect(alpha?.diagnostics.some(
      (diagnostic) => diagnostic.code === "dome.markdown.broken-wikilink",
    )).toBe(true);
    const question = alpha?.questions.find((question) =>
      question.question.includes("Possible duplicate pages")
    );
    expect(question?.id).toBeGreaterThan(0);
    expect(question?.resolveCommand).toBe(
      `dome resolve ${question?.id} <merge|keep separate>`,
    );

    const limitedText = await h.runCli([
      "export-context",
      "alpha launch",
      "--limit",
      "1",
    ]);
    expect(limitedText.exitCode).toBe(0);
    expect(limitedText.stderr).toBe("");
    expect(limitedText.stdout).toContain(
      "more adopted-state matches exist (increase --limit to include more entries)",
    );

    const limitedJson = await h.runCli([
      "export-context",
      "alpha launch",
      "--limit",
      "1",
      "--json",
    ]);
    expect(limitedJson.exitCode).toBe(0);
    expect(limitedJson.stderr).toBe("");
    const limitedPayload = JSON.parse(limitedJson.stdout) as {
      readonly limit: number;
      readonly shown: { readonly entries: number };
      readonly hasMore: { readonly entries: boolean };
      readonly markdown: string;
      readonly entries: ReadonlyArray<{ readonly path: string }>;
    };
    expect(limitedPayload.limit).toBe(1);
    expect(limitedPayload.shown.entries).toBe(1);
    expect(limitedPayload.hasMore.entries).toBe(true);
    expect(limitedPayload.entries).toHaveLength(1);
    expect(limitedPayload.markdown).toContain(
      "more adopted-state matches exist (increase --limit to include more entries)",
    );
  },
);
