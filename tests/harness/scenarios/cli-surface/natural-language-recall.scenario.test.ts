// End-to-end lexical recall canary: natural questions must reach the same
// target page through both query and context-packet surfaces.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: natural-language recall reaches target pages across query and export-context",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.search"] },
  },
  async (h) => {
    expect((await h.tick()).adopted).toBe(true);
    await h.userCommit({
      files: {
        "wiki/entities/alice-chen.md": [
          "---",
          "type: person",
          "---",
          "# Alice Chen",
          "",
          "Alice Chen received the promotion and now owns the platform organization.",
          "",
        ].join("\n"),
        "wiki/meetings/weekly-open-items.md": [
          "---",
          "type: meeting",
          "---",
          "# Weekly open items",
          "",
          "Open threads and general priorities for operations.",
          "",
        ].join("\n"),
      },
      message: "seed natural-language recall canary",
    });
    expect((await h.tick()).adopted).toBe(true);

    const question = "What was the outcome of Alice Chen's promotion?";
    const query = await h.runCli(["query", question, "--json"]);
    expect(query.exitCode).toBe(0);
    const queryPayload = JSON.parse(query.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(queryPayload.matches.map((match) => match.path)).toContain(
      "wiki/entities/alice-chen.md",
    );
    expect(queryPayload.matches.map((match) => match.path)).not.toContain(
      "wiki/meetings/weekly-open-items.md",
    );

    const context = await h.runCli(["export-context", question, "--json"]);
    expect(context.exitCode).toBe(0);
    const contextPayload = JSON.parse(context.stdout) as {
      readonly entries: ReadonlyArray<{ readonly path: string }>;
    };
    expect(contextPayload.entries.map((entry) => entry.path)).toContain(
      "wiki/entities/alice-chen.md",
    );
  },
);
