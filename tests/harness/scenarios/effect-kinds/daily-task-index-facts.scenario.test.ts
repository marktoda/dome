// scenarios/effect-kinds/daily-task-index-facts.scenario.test.ts
//
// dome.daily.task-index projects explicit markdown action observations into
// page-scoped facts with stable source-ref identities. Re-inspecting a
// changed/deleted page replaces stale facts for that page, while moved action
// lines preserve semantic identity for daily/open-loop surfaces.

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
          "<!-- dome.daily:open-loops:start -->",
          "### Source-backed Open Loops",
          "- [ ] Generated open-loop copy",
          "<!-- dome.daily:open-loops:end -->",
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
    name: "effect-kinds: dome.daily.task-index keeps stable identity when task lines move",
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

    const path = "wiki/projects/alpha.md";
    const task = "Send Ada budget update";
    await h.userCommit({
      files: {
        [path]: [
          "# Alpha",
          "",
          "TODO: Send Ada budget update",
          "",
        ].join("\n"),
      },
      message: "add project task",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    const beforeRefs = sourceRefRowsForFacts(h, {
      predicate: "dome.daily.open_task",
      subjectId: path,
      objectString: task,
    });
    expect(beforeRefs).toHaveLength(1);
    const before = beforeRefs[0]?.[0];
    expect(before?.range?.startLine).toBe(3);
    expect(typeof before?.stableId).toBe("string");

    await h.userCommit({
      files: {
        [path]: [
          "# Alpha",
          "",
          "Context line that moves the task down.",
          "",
          "TODO: Send Ada budget update",
          "",
        ].join("\n"),
      },
      message: "move project task",
    });
    const moved = await h.tick();
    expect(moved.adopted).toBe(true);

    const afterRefs = sourceRefRowsForFacts(h, {
      predicate: "dome.daily.open_task",
      subjectId: path,
      objectString: task,
    });
    expect(afterRefs).toHaveLength(1);
    const after = afterRefs[0]?.[0];
    expect(after?.range?.startLine).toBe(5);
    expect(after?.stableId).toBe(before?.stableId);
  },
);

scenario(
  {
    name: "effect-kinds: dome.daily.task-index refreshes stable ambiguous followup questions",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
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

    const path = "wiki/projects/beta.md";
    const prose = "We should follow up with Sam about hiring";
    await h.userCommit({
      files: {
        [path]: ["# Beta", "", prose, ""].join("\n"),
      },
      message: "add ambiguous followup",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    const before = openQuestionRows(h);
    expect(before).toHaveLength(1);
    expect(before[0]?.idempotency_key).toMatch(
      /^dome\.daily\.ambiguous-followup:/,
    );
    expect(before[0]?.sourceRefs[0]?.range?.startLine).toBe(3);
    expect(typeof before[0]?.sourceRefs[0]?.stableId).toBe("string");

    await h.userCommit({
      files: {
        [path]: ["# Beta", "", "Context line.", "", prose, ""].join("\n"),
      },
      message: "move ambiguous followup",
    });
    const moved = await h.tick();
    expect(moved.adopted).toBe(true);

    const after = openQuestionRows(h);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.idempotency_key).toBe(before[0]?.idempotency_key);
    expect(after[0]?.sourceRefs[0]?.range?.startLine).toBe(5);
    expect(after[0]?.sourceRefs[0]?.stableId).toBe(
      before[0]?.sourceRefs[0]?.stableId,
    );
    expect(after[0]?.question).toContain(`${path}:5`);
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
      "resolve",
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
  readonly object_json?: string;
};

type QuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly source_refs: string;
  readonly idempotency_key: string;
};

type OpenQuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly idempotency_key: string;
  readonly sourceRefs: ReadonlyArray<SourceRefProjection>;
};

type SourceRefProjection = {
  readonly path?: unknown;
  readonly stableId?: unknown;
  readonly range?: {
    readonly startLine?: unknown;
    readonly endLine?: unknown;
  };
};

function sourceRefRowsForFacts(
  h: Harness,
  filter: {
    readonly predicate: string;
    readonly subjectId: string;
    readonly objectString?: string;
  },
): ReadonlyArray<ReadonlyArray<SourceRefProjection>> {
  const rows = h.projection.raw
    .query<SourceRefRow, [string, string]>(
      "SELECT source_refs, object_json FROM facts WHERE predicate = ? AND subject_id = ?",
    )
    .all(filter.predicate, filter.subjectId);
  return rows
    .filter((row) =>
      filter.objectString === undefined ||
      rowObjectString(row.object_json) === filter.objectString
    )
    .map((row) => JSON.parse(row.source_refs) as SourceRefProjection[]);
}

function openQuestionRows(h: Harness): ReadonlyArray<OpenQuestionRow> {
  return h.projection.raw
    .query<QuestionRow, []>(
      "SELECT id, question, source_refs, idempotency_key FROM questions WHERE answered_at IS NULL ORDER BY id",
    )
    .all()
    .map((row) =>
      Object.freeze({
        id: row.id,
        question: row.question,
        idempotency_key: row.idempotency_key,
        sourceRefs: JSON.parse(row.source_refs) as SourceRefProjection[],
      })
    );
}

function rowObjectString(objectJson: string | undefined): string | null {
  if (objectJson === undefined) return null;
  const parsed = JSON.parse(objectJson) as {
    readonly kind?: unknown;
    readonly value?: unknown;
  };
  return parsed.kind === "string" && typeof parsed.value === "string"
    ? parsed.value
    : null;
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
