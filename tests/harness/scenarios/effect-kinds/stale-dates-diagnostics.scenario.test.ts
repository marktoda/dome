// scenarios/effect-kinds/stale-dates-diagnostics.scenario.test.ts
//
// Pins the snapshot metadata boundary end to end: the processor reads
// frontmatter from the candidate tree, reads the path's last git commit date
// through `ctx.snapshot.getFileInfo`, and emits a warning without blocking
// adoption.

import { expect } from "bun:test";

import { scenario } from "../../index";

const COMMITTER = {
  name: "Dome Test",
  email: "test@local",
  timestamp: Date.parse("2026-05-28T12:00:00.000Z") / 1000,
};

scenario(
  {
    name: "effect-kinds: dome.markdown.stale-dates warns when updated date trails git date",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/project-alpha.md":
          "---\n" +
          "type: project\n" +
          "updated: 2026-05-01\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "The project moved forward today.\n",
      },
      message: "update project alpha",
      committer: COMMITTER,
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.stale-updated" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.stale-updated" })
      .toContainMessage("was last changed on 2026-05-28");
    await h
      .expectLedger({ processorId: "dome.markdown.stale-dates" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: dome.markdown.stale-dates handles bulk changed pages",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "regression" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": markdownConfig({ processorTimeoutMs: 2_000 }),
      },
    },
    timeoutMs: 10_000,
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: bulkPages(180),
      message: "bulk stale date pages",
      committer: COMMITTER,
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectLedger({ processorId: "dome.markdown.stale-dates" })
      .toAllHaveStatus("succeeded");
    await h
      .expectProjection()
      .diagnostics({ code: "processor.timeout" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.stale-updated" })
      .toHaveCount(180);
  },
);

function bulkPages(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const id = i.toString().padStart(3, "0");
    files[`wiki/bulk-${id}.md`] =
      "---\n" +
      "type: note\n" +
      `id: bulk-${id}\n` +
      "updated: 2026-05-01\n" +
      "---\n" +
      `# Bulk ${id}\n\n` +
      `Unique management note ${id} moved forward today.\n`;
  }
  return files;
}

function markdownConfig(opts: { readonly processorTimeoutMs: number }): string {
  return [
    "engine:",
    `  processor_timeout_ms: ${opts.processorTimeoutMs}`,
    "extensions:",
    "  dome.markdown:",
    "    enabled: true",
    "    grant:",
    "      read:",
    "        - \"**/*.md\"",
    "        - \".dome/page-types.yaml\"",
    "        - \"**/*.{png,jpg,jpeg,gif,webp,svg,avif}\"",
    "        - \"raw/**\"",
    "      patch.auto:",
    "        - \"**/*.md\"",
    "      question.ask: true",
    "",
  ].join("\n");
}
