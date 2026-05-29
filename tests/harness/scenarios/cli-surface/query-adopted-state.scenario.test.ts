// scenarios/cli-surface/query-adopted-state.scenario.test.ts
//
// dome.search indexes adopted markdown via SearchDocumentEffect, and
// `dome query` invokes the view-phase query processor against that projection.
// This is end-to-end by design: shipped bundle loading, adoption dispatch,
// search.write capability enforcement, FTS projection writes, graph facts,
// and CLI rendering all run through the real runtime.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome query searches adopted markdown and related facts",
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
          "Roadmap notes for the alpha launch and ownership model.\n",
        "wiki/other.md": "# Other\n\nUnrelated operations note.\n",
      },
      message: "add searchable project note",
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const cli = await h.runCli(["query", "alpha launch", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    const payload = JSON.parse(cli.stdout) as {
      readonly query: string;
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly title: string;
        readonly type: string | null;
        readonly facts: ReadonlyArray<{ readonly predicate: string }>;
      }>;
    };

    expect(payload.query).toBe("alpha launch");
    const paths = payload.matches.map((m) => m.path);
    expect(paths).toContain("wiki/project-alpha.md");
    expect(paths).not.toContain("wiki/other.md");

    const match = payload.matches.find((m) => m.path === "wiki/project-alpha.md");
    expect(match?.title).toBe("Project Alpha");
    expect(match?.type).toBe("project");
    expect(match?.facts.some((fact) => fact.predicate === "dome.graph.tagged"))
      .toBe(true);

    await h.userCommit({
      files: { "wiki/project-alpha.md": null },
      message: "remove project note",
    });
    const deleteSync = await h.tick();
    expect(deleteSync.adopted).toBe(true);

    const afterDelete = await h.runCli(["query", "alpha launch", "--json"]);
    expect(afterDelete.exitCode).toBe(0);
    const deletedPayload = JSON.parse(afterDelete.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(deletedPayload.matches.map((m) => m.path)).not.toContain(
      "wiki/project-alpha.md",
    );
  },
);
