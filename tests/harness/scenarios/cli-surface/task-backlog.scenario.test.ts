// scenarios/cli-surface/task-backlog.scenario.test.ts
//
// `dome run task-backlog` is the read-only, revision-bound review document
// over the same projected open-task selector as Today.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome run task-backlog returns a revision-bound review page",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.daily"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/projects/launch.md": [
          "# Launch",
          "",
          "- [ ] #task Review launch plan ^tlaunch-review",
          "- [ ] #task Review launch plan ^tlaunch-copy",
          "- [ ] #task Send launch note 📅 2026-07-15 ^tlaunch-note",
          "",
        ].join("\n"),
      },
      message: "add launch review tasks",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const result = await h.runCli([
      "run",
      "task-backlog",
      "--date",
      "2026-07-16",
      "--limit",
      "10",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);

    const payload = structuredData(result.stdout) as {
      readonly schema: string;
      readonly status: string;
      readonly revision: string;
      readonly groups: {
        readonly overdue: number;
        readonly exactDuplicateCandidates: number;
      };
      readonly page: {
        readonly returned: number;
        readonly total: number;
        readonly commitments: number;
        readonly limit: number;
        readonly hasMore: boolean;
        readonly nextCursor: string | null;
      };
      readonly items: ReadonlyArray<{
        readonly normalizedText: string;
        readonly reviewable: boolean;
        readonly members: ReadonlyArray<{
          readonly blockId?: string;
          readonly sourceRefs: ReadonlyArray<{
            readonly commit: string;
            readonly path: string;
            readonly stableId?: string;
          }>;
        }>;
      }>;
    };

    expect(payload.schema).toBe("dome.daily.task-backlog.list/v1");
    expect(payload.status).toBe("ok");
    expect(payload.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.groups).toMatchObject({
      overdue: 1,
      exactDuplicateCandidates: 1,
    });
    expect(payload.page).toEqual({
      returned: 2,
      total: 2,
      commitments: 3,
      limit: 10,
      hasMore: false,
      nextCursor: null,
    });

    const duplicate = payload.items.find(
      (item) => item.normalizedText === "review launch plan",
    );
    expect(duplicate?.reviewable).toBe(true);
    expect(duplicate?.members.map((member) => member.blockId)).toEqual([
      "tlaunch-review",
      "tlaunch-copy",
    ]);
    expect(duplicate?.members.every((member) =>
      member.sourceRefs.some((ref) =>
        ref.commit === payload.revision &&
        ref.path === "wiki/projects/launch.md" &&
        ref.stableId?.startsWith("dome.daily.open-loop:") === true
      )
    )).toBe(true);
  },
);

function structuredData(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { readonly data?: unknown };
  return envelope.data;
}
