// scenarios/effect-kinds/daily-task-index-facts.scenario.test.ts
//
// dome.daily.task-index projects explicit markdown action observations into
// page-scoped facts. The processor intentionally does not assign stable task
// identities yet; these scenarios lock the current projection lifecycle:
// re-inspecting a changed/deleted page replaces stale facts for that page.

import { expect } from "bun:test";

import { scenario } from "../../index";
import type { Harness } from "../../types";

const CONFIG = `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      patch.auto: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`;

scenario(
  {
    name: "effect-kinds: dome.daily.task-index replaces task facts on edit and delete",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-03",
          "---",
          "",
          "# 2026-01-03",
          "",
          "- [ ] #followup Send Ada notes",
          "- [ ] Draft launch memo",
          "",
        ].join("\n"),
      },
      message: "add daily tasks",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(2);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-03",
          "---",
          "",
          "# 2026-01-03",
          "",
          "- [x] #followup Send Ada notes",
          "- [ ] Draft launch memo revised",
          "",
        ].join("\n"),
      },
      message: "complete followup task",
    });
    const edited = await h.tick();
    expect(edited.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
        objectString: "Draft launch memo revised",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
        objectString: "Send Ada notes",
      })
      .toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(0);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": null,
      },
      message: "delete daily task page",
    });
    const deleted = await h.tick();
    expect(deleted.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(0);

    await h
      .expectLedger({ processorId: "dome.daily.task-index" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: dome.daily.task-index extracts directives and asks on ambiguous followups",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/dailies/2026-01-04.md";
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: daily",
          "recurrence: 2026-01-04",
          "---",
          "",
          "# 2026-01-04",
          "",
          "TODO: Send budget update",
          "Follow up: Confirm Q3 plan with Eli",
          "We should follow up with Sam about hiring",
          "12 assets is the right starting number, with potential to follow up with more.",
          "",
        ].join("\n"),
      },
      message: "add daily directives",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
      })
      .toHaveCount(2);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
        objectString: "Send budget update",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
        objectString: "Confirm Q3 plan with Eli",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Confirm Q3 plan with Eli",
      })
      .toHaveCount(1);

    await h.expectProjection().questions().toHaveCount(1);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Possible follow-up");
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("We should follow up with Sam about hiring");

    expect(
      sourceRefRowsForFacts(h, {
        predicate: "dome.daily.open_task",
        subjectId: path,
      }).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);
    expect(
      sourceRefRowsForFacts(h, {
        predicate: "dome.daily.followup",
        subjectId: path,
      }).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);
    expect(
      sourceRefRowsForQuestions(h).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);

    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: daily",
          "recurrence: 2026-01-04",
          "---",
          "",
          "# 2026-01-04",
          "",
          "TODO: Send budget update",
          "Follow up: Confirm Q3 plan with Eli",
          "Follow up: Check in with Sam about hiring",
          "",
        ].join("\n"),
      },
      message: "clarify ambiguous followup",
    });
    const clarified = await h.tick();
    expect(clarified.adopted).toBe(true);

    await h.expectProjection().questions().toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Check in with Sam about hiring",
      })
      .toHaveCount(1);
  },
);

scenario(
  {
    name: "effect-kinds: dome.daily.task-index extracts source-ref-backed capture followups",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/captures/2026-01-05.md";
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: source",
          "title: 2026-01-05 capture",
          "---",
          "",
          "# 2026-01-05 capture",
          "",
          "TODO: Send Ada the launch staffing note",
          "Follow up: Ask Ben about hiring budget",
          "We should follow up with Cy about review timing",
          "",
        ].join("\n"),
      },
      message: "add capture followups",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
      })
      .toHaveCount(2);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Ask Ben about hiring budget",
      })
      .toHaveCount(1);
    await h.expectProjection().questions().toHaveCount(1);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("We should follow up with Cy about review timing");

    expect(
      sourceRefRowsForFacts(h, {
        predicate: "dome.daily.open_task",
        subjectId: path,
      }).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);
    expect(
      sourceRefRowsForFacts(h, {
        predicate: "dome.daily.followup",
        subjectId: path,
      }).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);
    expect(
      sourceRefRowsForQuestions(h).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);

    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: source",
          "title: 2026-01-05 capture",
          "---",
          "",
          "# 2026-01-05 capture",
          "",
          "TODO: Send Ada the launch staffing note",
          "Follow up: Ask Ben about hiring budget",
          "Follow up: Check with Cy about review timing",
          "",
        ].join("\n"),
      },
      message: "clarify capture followup",
    });
    const clarified = await h.tick();
    expect(clarified.adopted).toBe(true);

    await h.expectProjection().questions().toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Check with Cy about review timing",
      })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        [path]: null,
      },
      message: "delete capture",
    });
    const deleted = await h.tick();
    expect(deleted.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
      })
      .toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
      })
      .toHaveCount(0);
  },
);

scenario(
  {
    name: "effect-routing: dome.daily tracks accepted ambiguous followup answers",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-answer" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/projects/alpha.md";
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: project",
          "title: Alpha",
          "---",
          "",
          "# Alpha",
          "",
          "We should follow up with Sam about hiring",
          "",
        ].join("\n"),
      },
      message: "add ambiguous project followup",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    const questions = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly idempotency_key: string;
    }>;
    expect(questions).toHaveLength(1);
    const question = questions[0];
    expect(question?.status).toBe("open");
    expect(
      question?.idempotency_key.startsWith("dome.daily.ambiguous-followup:"),
    ).toBe(true);
    if (question === undefined) return;

    const answer = await h.runCli([
      "answer",
      String(question.id),
      "track",
      "--json",
    ]);
    expect(answer.exitCode).toBe(0);
    const payload = JSON.parse(answer.stdout) as {
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly processor_id: string }>;
        readonly sub_proposals: number;
      };
    };
    expect(payload.handlers.status).toBe("handled");
    expect(payload.handlers.runs.map((run) => run.processor_id)).toEqual([
      "dome.daily.ambiguous-followup-answer",
    ]);
    expect(payload.handlers.sub_proposals).toBe(1);

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    await h.expectFile(path, { atCommit: adopted }).toContain(
      "<!-- dome.daily:tracked-followups:start -->",
    );
    await h.expectFile(path, { atCommit: adopted }).toContain(
      "- [ ] #followup Follow up with Sam about hiring",
    );

    const afterQuestions = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly answer: string | null;
    }>;
    expect(afterQuestions).toEqual([
      expect.objectContaining({
        id: question.id,
        status: "answered",
        answer: "track",
      }),
    ]);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
        objectString: "Follow up with Sam about hiring",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Follow up with Sam about hiring",
      })
      .toHaveCount(1);

    const rebuild = await h.runCli(["rebuild", "--json"]);
    expect(rebuild.exitCode).toBe(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Follow up with Sam about hiring",
      })
      .toHaveCount(1);
  },
);

type SourceRefRow = {
  readonly source_refs: string;
};

type SourceRefProjection = {
  readonly path?: unknown;
  readonly range?: {
    readonly startLine?: unknown;
    readonly endLine?: unknown;
  };
};

function sourceRefRowsForFacts(
  h: Harness,
  filter: { readonly predicate: string; readonly subjectId: string },
): ReadonlyArray<ReadonlyArray<SourceRefProjection>> {
  return h.projection.raw
    .query<SourceRefRow, [string, string]>(
      "SELECT source_refs FROM facts WHERE predicate = ? AND subject_id = ?",
    )
    .all(filter.predicate, filter.subjectId)
    .map((row) => JSON.parse(row.source_refs) as SourceRefProjection[]);
}

function sourceRefRowsForQuestions(
  h: Harness,
): ReadonlyArray<ReadonlyArray<SourceRefProjection>> {
  return h.projection.raw
    .query<SourceRefRow, []>("SELECT source_refs FROM questions")
    .all()
    .map((row) => JSON.parse(row.source_refs) as SourceRefProjection[]);
}

function hasSourceRef(
  refs: ReadonlyArray<SourceRefProjection>,
  path: string,
): boolean {
  return refs.some(
    (ref) =>
      ref.path === path &&
      ref.range !== undefined &&
      typeof ref.range.startLine === "number" &&
      typeof ref.range.endLine === "number",
  );
}
