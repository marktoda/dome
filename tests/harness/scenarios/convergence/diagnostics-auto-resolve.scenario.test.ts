// scenarios/convergence/diagnostics-auto-resolve.scenario.test.ts
//
// Phase 14: when a processor re-checks a changed path and no longer emits a
// prior diagnostic for that path, the projection row is marked resolved and
// disappears from current diagnostic views.

import { expect } from "bun:test";

import { diagnosticEffect } from "../../../../src/core/effect";
import { commitOid } from "../../../../src/core/source-ref";
import { insertDiagnostic } from "../../../../src/projections/diagnostics";
import { scenario } from "../../index";

scenario(
  {
    name: "convergence: diagnostics auto-resolve after the changed file is fixed",
    tags: [
      { kind: "group", group: "convergence" },
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
        "wiki/ref.md":
          "---\n" +
          "type: note\n" +
          "updated: 2026-05-28\n" +
          "---\n" +
          "# Ref\n\n" +
          "See [[missing-target]].\n",
      },
      message: "add broken wikilink",
    });

    const broken = await h.tick();
    expect(broken.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/ref.md":
          "---\n" +
          "type: note\n" +
          "updated: 2026-05-28\n" +
          "---\n" +
          "# Ref\n\n" +
          "No broken links remain.\n",
      },
      message: "fix broken wikilink",
    });

    const fixed = await h.tick();
    expect(fixed.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);
    const resolvedRows = h.projection.raw
      .query<{ resolved_at: string | null }, []>(
        "SELECT resolved_at FROM diagnostics WHERE code = 'dome.markdown.broken-wikilink'",
    )
      .all();
    expect(resolvedRows.length).toBe(1);
    expect(typeof resolvedRows[0]?.resolved_at).toBe("string");
  },
);

scenario(
  {
    name: "convergence: wikilink diagnostics resolve when a missing target page is created",
    tags: [
      { kind: "group", group: "convergence" },
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
        "notes/Bilal.md": "# Bilal\n\nDiscuss with [[Fred Zaw]].\n",
      },
      message: "add note link before target exists",
    });

    const broken = await h.tick();
    expect(broken.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/entities/fred-zaw.md":
          "---\n" +
          "type: entity\n" +
          "---\n" +
          "# Fred Zaw\n",
      },
      message: "create missing target page",
    });

    const resolved = await h.tick();
    expect(resolved.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);
  },
);

scenario(
  {
    name: "convergence: diagnostics keep one current row when a changed file stays broken",
    tags: [
      { kind: "group", group: "convergence" },
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
        "wiki/ref.md":
          "---\n" +
          "type: note\n" +
          "updated: 2026-05-28\n" +
          "---\n" +
          "# Ref\n\n" +
          "See [[missing-target]].\n",
      },
      message: "add broken wikilink",
    });

    const first = await h.tick();
    expect(first.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    const firstRows = h.projection.raw
      .query<
        { adopted_commit: string; resolved_at: string | null },
        []
      >(
        "SELECT adopted_commit, resolved_at FROM diagnostics "
          + "WHERE code = 'dome.markdown.broken-wikilink' ORDER BY id",
      )
      .all();
    expect(firstRows.length).toBe(1);
    const firstCommit = firstRows[0]?.adopted_commit;
    expect(typeof firstCommit).toBe("string");

    await h.userCommit({
      files: {
        "wiki/ref.md":
          "---\n" +
          "type: note\n" +
          "updated: 2026-05-29\n" +
          "---\n" +
          "# Ref\n\n" +
          "Still see [[missing-target]].\n",
      },
      message: "edit file but leave broken wikilink",
    });

    const second = await h.tick();
    expect(second.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    const rows = h.projection.raw
      .query<
        { adopted_commit: string; resolved_at: string | null },
        []
      >(
        "SELECT adopted_commit, resolved_at FROM diagnostics "
          + "WHERE code = 'dome.markdown.broken-wikilink' ORDER BY id",
      )
      .all();
    expect(rows.length).toBe(2);
    expect(typeof rows[0]?.resolved_at).toBe("string");
    expect(rows[1]?.resolved_at).toBeNull();
    expect(rows[1]?.adopted_commit).not.toBe(firstCommit);
  },
);

scenario(
  {
    name: "convergence: obvious broken wikilink repairs converge without diagnostics",
    tags: [
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "adoption" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/ref.md": "# Ref\n\nSee [[wiki/entities/grce-danco|Grace]].\n",
        "wiki/entities/grace-danco.md": "# Grace Danco\n",
      },
      message: "add typoed wikilink",
    });

    const repaired = await h.tick();
    expect(repaired.adopted).toBe(true);
    await h
      .expectFile("wiki/ref.md")
      .toContain("[[wiki/entities/grace-danco|Grace]]");
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);

    const settled = await h.tick();
    expect(settled.hadDrift).toBe(false);
  },
);

scenario(
  {
    name: "convergence: source-less processor diagnostics resolve after clean rerun",
    tags: [
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "adoption" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": markdownConfig(),
      },
    },
  },
  async (h) => {
    const boot = await h.runCli(["sync", "--json"]);
    expect(boot.exitCode).toBe(0);
    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;

    insertDiagnostic(h.projection, {
      effect: diagnosticEffect({
        severity: "block",
        code: "capability-deny-patch",
        message: "stale source-less diagnostic",
        sourceRefs: [],
      }),
      processorId: "dome.markdown.normalize-frontmatter",
      proposalId: null,
      adoptedCommit: commitOid(adopted),
    });
    await h
      .expectProjection()
      .diagnostics({ code: "capability-deny-patch" })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "notes/noisy.md": "---\nid: noisy\ntype: note\n---\n# Noisy\n",
      },
      message: "add noisy frontmatter",
    });

    const fixed = await h.runCli(["sync", "--json"]);
    expect(fixed.exitCode).toBe(0);
    await h
      .expectProjection()
      .diagnostics({ code: "capability-deny-patch" })
      .toHaveCount(0);

    const resolvedRows = h.projection.raw
      .query<{ resolved_at: string | null }, []>(
        "SELECT resolved_at FROM diagnostics WHERE code = 'capability-deny-patch'",
      )
      .all();
    expect(resolvedRows.length).toBe(1);
    expect(typeof resolvedRows[0]?.resolved_at).toBe("string");
  },
);

scenario(
  {
    name: "convergence: source-less broker diagnostics resolve after grant repair",
    tags: [
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "adoption" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": markdownConfigWithPatchPaths(["wiki/**/*.md"]),
      },
    },
  },
  async (h) => {
    const boot = await h.runCli(["sync", "--json"]);
    expect(boot.exitCode).toBe(0);

    await h.userCommit({
      files: {
        "notes/noisy.md": "---\nid: noisy\ntype: note\n---\n# Noisy\n",
      },
      message: "add denied note frontmatter",
    });
    const blocked = await h.runCli(["sync", "--json"]);
    expect(blocked.exitCode).toBe(1);
    await h
      .expectProjection()
      .diagnostics({ code: "capability-deny-patch" })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        ".dome/config.yaml": markdownConfigWithPatchPaths(["**/*.md"]),
      },
      message: "repair markdown patch grants",
    });
    const repaired = await h.runCli(["sync", "--json"]);
    expect(repaired.exitCode).toBe(0);
    await h
      .expectProjection()
      .diagnostics({ code: "capability-deny-patch" })
      .toHaveCount(0);

    const unresolvedRows = h.projection.raw
      .query<{ resolved_at: string | null }, []>(
        "SELECT resolved_at FROM diagnostics "
          + "WHERE code = 'capability-deny-patch' "
          + "AND resolved_at IS NULL",
      )
      .all();
    expect(unresolvedRows).toEqual([]);
  },
);

function markdownConfig(): string {
  return markdownConfigWithPatchPaths(["**/*.md"]);
}

function markdownConfigWithPatchPaths(paths: ReadonlyArray<string>): string {
  return [
    "extensions:",
    "  dome.markdown:",
    "    enabled: true",
    "    grant:",
    "      read:",
    "        - \"**/*.md\"",
    "        - \".dome/page-types.yaml\"",
    "      patch.auto:",
    ...paths.map((path) => `        - "${path}"`),
    "      question.ask: true",
    "",
  ]
    .join("\n");
}
