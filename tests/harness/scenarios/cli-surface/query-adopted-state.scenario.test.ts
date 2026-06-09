// scenarios/cli-surface/query-adopted-state.scenario.test.ts
//
// dome.search indexes adopted markdown via SearchDocumentEffect, and
// `dome query` invokes the view-phase query processor against that projection.
// This is end-to-end by design: shipped bundle loading, adoption dispatch,
// search.write capability enforcement, FTS projection writes, graph facts,
// and CLI rendering all run through the real runtime.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const CONTEXT_SIGNAL_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.context-signal",
);

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

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
      { kind: "route", route: "view-command" },
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
          "  - launch\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "Roadmap notes for the alpha launch and ownership model.\n" +
          "\n" +
          "See [[missing-alpha-owner]].\n",
        "wiki/project-alpha-copy.md":
          "---\n" +
          "type: project\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "Roadmap notes for the alpha launch and ownership model.\n",
        "wiki/other.md": "# Other\n\nUnrelated operations note.\n",
      },
      message: "add searchable project note",
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli(["query", "alpha launch"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("source:");
    expect(text.stdout).toContain("why:");
    expect(text.stdout).toContain("wiki/project-alpha.md");
    expect(text.stdout).toContain("dome.graph.tagged x2");
    expect(text.stdout).toContain("questions:");
    expect(text.stdout).toContain("resolve: dome resolve ");

    const cli = await h.runCli(["query", "alpha launch", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    const payload = JSON.parse(cli.stdout) as {
      readonly query: string;
      readonly limit: number;
      readonly shown: { readonly matches: number };
      readonly hasMore: { readonly matches: boolean };
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly title: string;
        readonly type: string | null;
        readonly ranking: {
          readonly score: number;
          readonly ftsRank: number;
          readonly reasons: ReadonlyArray<string>;
        };
        readonly facts: ReadonlyArray<{ readonly predicate: string }>;
        readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
        readonly questions: ReadonlyArray<{
          readonly id: number;
          readonly question: string;
          readonly options: ReadonlyArray<string>;
          readonly resolveCommand: string;
          readonly metadata?: {
            readonly automationPolicy?: string;
          };
          readonly automationPolicy?: string;
        }>;
      }>;
    };

    expect(payload.query).toBe("alpha launch");
    expect(payload.limit).toBe(10);
    expect(payload.shown.matches).toBe(payload.matches.length);
    expect(payload.hasMore.matches).toBe(false);
    const paths = payload.matches.map((m) => m.path);
    expect(paths).toContain("wiki/project-alpha.md");
    expect(paths).not.toContain("wiki/other.md");

    const match = payload.matches.find((m) => m.path === "wiki/project-alpha.md");
    expect(match?.title).toBe("Project Alpha");
    expect(match?.type).toBe("project");
    expect(match?.ranking.score).toBeGreaterThan(0);
    expect(match?.ranking.reasons).toContain("project page");
    expect(match?.ranking.reasons.some((reason) => reason.includes("graph signal")))
      .toBe(true);
    expect(match?.facts.some((fact) => fact.predicate === "dome.graph.tagged"))
      .toBe(true);
    expect(
      match?.facts.filter((fact) => fact.predicate === "dome.graph.tagged")
        .length,
    ).toBe(2);
    expect(
      match?.diagnostics.some(
        (diagnostic) => diagnostic.code === "dome.markdown.broken-wikilink",
      ),
    ).toBe(true);
    expect(
      match?.questions.some((question) =>
        question.question.includes("Possible duplicate pages")
      ),
    ).toBe(true);
    const question = match?.questions.find((question) =>
      question.question.includes("Possible duplicate pages")
    );
    expect(question?.id).toBeGreaterThan(0);
    expect(question?.options).toEqual(["merge", "keep separate"]);
    expect(question?.resolveCommand).toBe(
      `dome resolve ${question?.id} <merge|keep separate>`,
    );
    expect(question?.metadata?.automationPolicy).toBe("owner-needed");
    expect(question?.automationPolicy).toBe("owner-needed");

    const limitedText = await h.runCli([
      "query",
      "alpha launch",
      "--limit",
      "1",
    ]);
    expect(limitedText.exitCode).toBe(0);
    expect(limitedText.stderr).toBe("");
    expect(limitedText.stdout).toContain(
      "more adopted-state matches exist; increase --limit to show more",
    );

    const limitedJson = await h.runCli([
      "query",
      "alpha launch",
      "--limit",
      "1",
      "--json",
    ]);
    expect(limitedJson.exitCode).toBe(0);
    expect(limitedJson.stderr).toBe("");
    const limitedPayload = JSON.parse(limitedJson.stdout) as {
      readonly limit: number;
      readonly shown: { readonly matches: number };
      readonly hasMore: { readonly matches: boolean };
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(limitedPayload.limit).toBe(1);
    expect(limitedPayload.shown.matches).toBe(1);
    expect(limitedPayload.hasMore.matches).toBe(true);
    expect(limitedPayload.matches).toHaveLength(1);

    h.projection.raw.run(
      "UPDATE projection_meta SET processor_versions_hash = 'stale-version-hash'",
    );
    h.projection.raw.run("DELETE FROM fts_documents");

    const afterCacheDrift = await h.runCli(["query", "alpha launch", "--json"]);
    expect(afterCacheDrift.exitCode).toBe(0);
    expect(afterCacheDrift.stderr).toBe("");
    const driftPayload = JSON.parse(afterCacheDrift.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(driftPayload.matches.map((m) => m.path)).toContain(
      "wiki/project-alpha.md",
    );

    const meta = h.projection.raw
      .query<{ processor_versions_hash: string | null }, []>(
        "SELECT processor_versions_hash FROM projection_meta",
      )
      .get();
    expect(meta?.processor_versions_hash).not.toBe("stale-version-hash");
    expect(typeof meta?.processor_versions_hash).toBe("string");

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

scenario(
  {
    name: "cli-surface: dome query recalls current daily surface for daily-intent queries",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "view-command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.search"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const today = localDateString();
    const dailyPath = `notes/${today}.md`;
    const oldDailyPath = "notes/2026-01-01.md";
    await h.userCommit({
      files: {
        [dailyPath]:
          `# ${today}\n\n` +
          "## Open Loops\n\n" +
          "- [ ] Handle the current launch review.\n",
        [oldDailyPath]:
          "---\n" +
          "type: daily\n" +
          "recurrence: 2026-01-01\n" +
          "---\n\n" +
          "# 2026-01-01\n\n" +
          "What should I work on today?\n\n" +
          "- [ ] Historical daily task should not be read-first today.\n",
      },
      message: "add current daily note",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const cli = await h.runCli([
      "query",
      "what should I work on today",
      "--json",
      "--limit",
      "5",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    const payload = JSON.parse(cli.stdout) as {
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly ranking: {
          readonly reasons: ReadonlyArray<string>;
          readonly signals: ReadonlyArray<{ readonly kind: string }>;
        };
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
    };

    expect(payload.matches[0]?.path).toBe(dailyPath);
    expect(payload.matches.map((match) => match.path)).not.toContain(
      oldDailyPath,
    );
    expect(payload.matches[0]?.ranking.reasons).toContain(
      "current daily surface",
    );
    expect(payload.matches[0]?.ranking.signals).toContainEqual(
      expect.objectContaining({ kind: "recall" }),
    );
    expect(payload.matches[0]?.sourceRefs).toContainEqual(
      expect.objectContaining({ path: dailyPath }),
    );
  },
);

scenario(
  {
    name: "cli-surface: dome query bounds related facts for highly connected pages",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "view-command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph", "dome.search"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/noisy-alpha-log.md":
          "---\n" +
          "type: project\n" +
          "tags:\n" +
          "  - alpha\n" +
          "  - launch\n" +
          Array.from({ length: 24 }, (_, i) => `  - noisy-${i}\n`).join("") +
          "---\n" +
          "# Noisy Alpha Log\n\n" +
          "Alpha launch working notes with many extracted graph facts.\n",
      },
      message: "add highly connected query page",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const cli = await h.runCli([
      "query",
      "alpha launch",
      "--json",
      "--limit",
      "1",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    const payload = JSON.parse(cli.stdout) as {
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly ranking: { readonly reasons: ReadonlyArray<string> };
        readonly facts: ReadonlyArray<{
          readonly predicate: string;
          readonly object: { readonly value?: string };
        }>;
      }>;
    };
    const match = payload.matches.find((row) =>
      row.path === "wiki/noisy-alpha-log.md"
    );
    expect(match).toBeDefined();
    expect(match?.facts.length).toBeLessThanOrEqual(8);
    expect(match?.ranking.reasons).toContain("many graph signals");
    expect(match?.facts).toContainEqual(
      expect.objectContaining({
        predicate: "dome.graph.tagged",
        object: expect.objectContaining({ value: "alpha" }),
      }),
    );
    expect(match?.facts).toContainEqual(
      expect.objectContaining({
        predicate: "dome.graph.tagged",
        object: expect.objectContaining({ value: "launch" }),
      }),
    );
  },
);

scenario(
  {
    name: "cli-surface: dome query recalls pages through projection signals",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "view-command" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        "dome.search",
        { id: "test.context-signal", root: CONTEXT_SIGNAL_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/signal-only.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Operations Notebook\n\n" +
          "This page intentionally avoids the packet topic in searchable prose.\n",
      },
      message: "add signal-only query page",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const text = await h.runCli(["query", "alpha launch", "--limit", "3"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("wiki/signal-only.md");
    expect(text.stdout).toContain("why: open-loop topic match");
    expect(text.stdout).toContain("dome.daily.open_task");

    const cli = await h.runCli(["query", "alpha launch", "--json", "--limit", "3"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    const payload = JSON.parse(cli.stdout) as {
      readonly shown: { readonly matches: number };
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly snippet: string;
        readonly ranking: {
          readonly reasons: ReadonlyArray<string>;
          readonly signals: ReadonlyArray<{ readonly kind: string }>;
        };
        readonly facts: ReadonlyArray<{
          readonly predicate: string;
          readonly object: { readonly value?: string };
        }>;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
    };

    expect(payload.shown.matches).toBeGreaterThan(0);
    const entry = payload.matches.find((match) =>
      match.path === "wiki/signal-only.md"
    );
    expect(entry).toBeDefined();
    expect(entry?.snippet).toContain("intentionally avoids the packet topic");
    expect(entry?.ranking.reasons).toContain("open-loop topic match");
    expect(entry?.ranking.signals.some((signal) => signal.kind === "recall"))
      .toBe(true);
    expect(entry?.facts).toContainEqual(
      expect.objectContaining({
        predicate: "dome.daily.open_task",
        object: expect.objectContaining({
          value: "Call Riley about alpha launch readiness",
        }),
      }),
    );
    expect(entry?.sourceRefs[0]?.path).toBe("wiki/signal-only.md");

    const filtered = await h.runCli([
      "query",
      "alpha launch",
      "--json",
      "--type",
      "project",
    ]);
    expect(filtered.exitCode).toBe(0);
    const filteredPayload = JSON.parse(filtered.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(filteredPayload.matches.map((match) => match.path)).not.toContain(
      "wiki/signal-only.md",
    );
  },
);

scenario(
  {
    name: "cli-surface: dome query returns section hits and link-expanded pages without regressing exact-name queries",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "view-command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph", "dome.search"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/entities/danny-rosen.md":
          "---\n" +
          "type: person\n" +
          "---\n" +
          "# Danny Rosen\n\n" +
          "Danny Rosen owns the rollout. See [[platform-hub]].\n\n" +
          "## Rollout Notes\n\n" +
          "Danny Rosen reviews the launch checklist weekly.\n",
        // Never matches "danny rosen" in FTS — reachable only through the
        // wikilink from the direct hit (one-hop expansion channel).
        "wiki/platform-hub.md":
          "---\n" +
          "type: project\n" +
          "---\n" +
          "# Platform Hub\n\n" +
          "Infrastructure boundaries and shared runtime ownership.\n",
      },
      message: "add entity page linking to hub",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    // Exact entity-name query: the direct hit stays #1; the linked hub joins
    // the candidate set through the expansion channel but cannot outrank it
    // (acceptance per docs/memory.md §M1).
    const cli = await h.runCli(["query", "danny rosen", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    const payload = JSON.parse(cli.stdout) as {
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly sectionId: string | null;
        readonly breadcrumb: string | null;
        readonly ranking: {
          readonly recencyFactor: number;
          readonly reasons: ReadonlyArray<string>;
          readonly signals: ReadonlyArray<{ readonly kind: string }>;
        };
        readonly sourceRefs: ReadonlyArray<{
          readonly path: string;
          readonly range?: { readonly startLine: number };
        }>;
      }>;
    };
    expect(payload.matches[0]?.path).toBe("wiki/entities/danny-rosen.md");
    expect(payload.matches[0]?.sectionId).not.toBeNull();
    expect(payload.matches[0]?.breadcrumb).toContain("Danny Rosen");
    expect(payload.matches[0]?.ranking.signals).toContainEqual(
      expect.objectContaining({ kind: "fusion", label: "text match" }),
    );
    expect(typeof payload.matches[0]?.ranking.recencyFactor).toBe("number");
    expect(payload.matches[0]?.sourceRefs[0]?.range?.startLine)
      .toBeGreaterThan(0);

    const hub = payload.matches.find((m) => m.path === "wiki/platform-hub.md");
    expect(hub).toBeDefined();
    expect(hub?.ranking.reasons).toContain("linked from matches");

    // A query matching only H2-section content surfaces the section
    // breadcrumb in text output.
    const sectionText = await h.runCli(["query", "launch checklist"]);
    expect(sectionText.exitCode).toBe(0);
    expect(sectionText.stderr).toBe("");
    expect(sectionText.stdout).toContain(
      "section: Danny Rosen › Rollout Notes",
    );

    const sectionJson = await h.runCli(["query", "launch checklist", "--json"]);
    const sectionPayload = JSON.parse(sectionJson.stdout) as {
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly sectionId: string | null;
        readonly breadcrumb: string | null;
      }>;
    };
    const sectionMatch = sectionPayload.matches.find(
      (m) => m.path === "wiki/entities/danny-rosen.md",
    );
    expect(sectionMatch?.sectionId).toBe("rollout-notes");
    expect(sectionMatch?.breadcrumb).toBe("Danny Rosen › Rollout Notes");
  },
);

scenario(
  {
    name: "cli-surface: first sync bootstraps adopted-state search for existing vaults",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "view-command" },
    ],
    harness: {
      bundles: ["dome.markdown", "dome.graph", "dome.search"],
      initialFiles: {
        "wiki/existing.md":
          "---\n" +
          "type: concept\n" +
          "---\n" +
          "# Existing Vault\n\n" +
          "Dome should index this note on the first sync.\n",
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const cli = await h.runCli(["query", "first sync", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    const payload = JSON.parse(cli.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(payload.matches.map((match) => match.path)).toContain(
      "wiki/existing.md",
    );
  },
);
