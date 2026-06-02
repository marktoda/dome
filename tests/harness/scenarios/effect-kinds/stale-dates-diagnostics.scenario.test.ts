// scenarios/effect-kinds/stale-dates-diagnostics.scenario.test.ts
//
// Pins the managed-date freshness path end to end: normalize-frontmatter reads
// the path's last git commit date through `ctx.snapshot.getFileInfo`, refreshes
// stale `updated:` frontmatter during the fixed-point loop, and leaves no
// stale-date diagnostic in the adopted projection.

import { expect } from "bun:test";

import { scenario } from "../../index";

const COMMITTER = {
  name: "Dome Test",
  email: "test@local",
  timestamp: Date.parse("2026-05-28T12:00:00.000Z") / 1000,
};

scenario(
  {
    name: "effect-kinds: dome.markdown refreshes stale updated dates during adoption",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
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
    expect(result.diagnosticCount).toBe(0);
    expect(result.iterations).toBeGreaterThan(1);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.stale-updated" })
      .toHaveCount(0);
    await h.expectFile("wiki/project-alpha.md").toNotContain("updated: 2026-05-01");
    await h.expectFile("wiki/project-alpha.md").toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
    await h
      .expectLedger({ processorId: "dome.markdown.stale-dates" })
      .toAllHaveStatus("succeeded");
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: dome.markdown refreshes stale updated dates in bulk",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "regression" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": markdownConfig({ processorTimeoutMs: 15_000 }),
      },
    },
    timeoutMs: 30_000,
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
    expect(result.diagnosticCount).toBe(0);

    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");
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
      .toHaveCount(0);
    await h.expectFile("wiki/bulk-000.md").toNotContain("updated: 2026-05-01");
  },
);

function bulkPages(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const id = i.toString().padStart(3, "0");
    files[`wiki/bulk-${id}.md`] =
      "---\n" +
      "type: concept\n" +
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
