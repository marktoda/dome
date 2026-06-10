// scenarios/effect-routing/preference-promotion.scenario.test.ts
//
// Preference promotion end-to-end (memory-quality M5,
// docs/wiki/specs/preferences.md): owner-correction signals accrue in
// preferences/signals.md → the deterministic counter emits rebuildable
// dome.preference.topic facts → 3 same-sign signals within 30 days raise ONE
// owner-needed promotion question → resolving `promote` lands the rule in
// core.md's generated block through the single-auto-writer answer handler
// (narrow per-processor grant) → the counter sees the promoted state and
// stays quiet. Rejecting a second topic appends the owner tombstone and
// retires it. The dome.agent bundle runs WITHOUT a model provider — the
// preference processors are deterministic; the agent loops no-op.

import { expect } from "bun:test";

import { scenario } from "../../index";

const CANDIDATE_RULE = "meeting notes go under notes/, not entities/";

// Bundle-level grant mirrors the shipped defaults (core.md read-only) plus
// the per-processor replacement grant for the single auto-writer — the
// canonical shape from preferences.md §"The single-auto-writer exception".
const CONFIG = `
extensions:
  dome.agent:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "inbox/**/*.md"
        - "index.md"
        - "log.md"
        - "consolidation-ledger.md"
        - "sources/calendar/*.md"
        - "core.md"
        - "preferences/signals.md"
      patch.auto:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "index.md"
        - "log.md"
        - "consolidation-ledger.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
        - "preferences/signals.md"
      graph.write:
        - "dome.preference.*"
      model.invoke:
        maxDailyCostUsd: 5
      question.ask: true
    processors:
      dome.agent.preference-promotion-answer:
        grant:
          read:
            - "core.md"
            - "preferences/signals.md"
          patch.auto:
            - "core.md"
            - "preferences/signals.md"
`;

type QuestionRow = {
  readonly id: number;
  readonly status: string;
  readonly idempotency_key: string;
  readonly question: string;
  readonly metadata:
    | { readonly automationPolicy?: string; readonly confidence?: number }
    | "-";
};

scenario(
  {
    name: "effect-routing: preference signals raise an owner question; promote lands the core.md block; reject tombstones the topic",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-signal" },
      { kind: "route", route: "garden-answer" },
    ],
    harness: {
      bundles: ["dome.agent"],
      initialFiles: { ".dome/config.yaml": CONFIG },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // Three supporting corrections inside the 30-day window for `filing`,
    // three for `naming`, plus one malformed line (info diagnostic, no crash).
    await h.userCommit({
      files: {
        "preferences/signals.md": [
          "- 2026-06-01 + filing:: meeting notes go under notes/ (source: [[wiki/dailies/2026-06-01]])",
          "- 2026-06-05 + filing:: meeting notes go under notes/",
          `- 2026-06-09 + filing:: ${CANDIDATE_RULE}`,
          "- 2026-06-02 + naming:: kebab-case page slugs",
          "- 2026-06-06 + naming:: kebab-case page slugs",
          "- 2026-06-08 + naming:: kebab-case page slugs",
          "- this line is not a signal",
          "",
        ].join("\n"),
      },
      message: "record preference signals",
    });
    expect((await h.tick()).adopted).toBe(true);

    // Counter facts in the projection (rebuildable substrate).
    await h
      .expectProjection()
      .facts({
        predicate: "dome.preference.topic",
        subjectId: "preferences/signals.md",
      })
      .toHaveCount(2);

    // Exactly one owner-needed promotion question per candidate topic.
    const rows = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<QuestionRow>;
    const promotionRows = rows.filter((row) =>
      row.idempotency_key.startsWith("dome.agent.preference-promotion:"),
    );
    expect(promotionRows).toHaveLength(2);
    const filing = promotionRows.find((row) =>
      row.idempotency_key.includes(":filing:"),
    );
    const naming = promotionRows.find((row) =>
      row.idempotency_key.includes(":naming:"),
    );
    expect(filing?.status).toBe("open");
    expect(filing?.question).toContain(CANDIDATE_RULE);
    expect(filing?.metadata).toEqual(
      expect.objectContaining({
        automationPolicy: "owner-needed",
        confidence: 0.4385,
      }),
    );
    expect(naming?.status).toBe("open");
    if (filing === undefined || naming === undefined) return;

    // Idempotency: a re-tick does not duplicate the open questions.
    expect((await h.tick()).adopted).toBe(true);
    const afterRetick = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<QuestionRow>;
    expect(
      afterRetick.filter((row) =>
        row.idempotency_key.startsWith("dome.agent.preference-promotion:"),
      ),
    ).toHaveLength(2);

    // Promote `filing`: the answer handler — THE single auto-writer to
    // core.md — splices the rule into the generated block.
    const promote = await h.runCli([
      "resolve",
      String(filing.id),
      "promote",
      "--json",
    ]);
    expect(promote.exitCode).toBe(0);
    const promoteBody = JSON.parse(promote.stdout) as {
      readonly handlers: { readonly status: string };
    };
    expect(promoteBody.handlers.status).toBe("handled");

    const adoptedAfterPromote = await h.refs.adopted();
    expect(adoptedAfterPromote).not.toBeNull();
    if (adoptedAfterPromote === null) return;
    await h
      .expectFile("core.md", { atCommit: adoptedAfterPromote })
      .toContain("<!-- dome.agent:promoted-preferences:start -->");
    await h
      .expectFile("core.md", { atCommit: adoptedAfterPromote })
      .toContain(`- filing:: ${CANDIDATE_RULE} (confidence 0.44)`);

    // The core.md change re-fires the counter: the topic reads as promoted,
    // and the promotion processor stays quiet (no new question; the answered
    // row stays answered).
    expect((await h.tick()).adopted).toBe(true);
    const afterPromote = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<QuestionRow>;
    const filingRows = afterPromote.filter((row) =>
      row.idempotency_key.includes(":filing:"),
    );
    expect(filingRows).toHaveLength(1);
    expect(filingRows[0]?.status).toBe("answered");

    // Reject `naming`: the handler appends the owner tombstone to the
    // signals page; the topic is retired and never re-proposed.
    const reject = await h.runCli([
      "resolve",
      String(naming.id),
      "reject",
      "--json",
    ]);
    expect(reject.exitCode).toBe(0);
    expect(
      (JSON.parse(reject.stdout) as { handlers: { status: string } }).handlers
        .status,
    ).toBe("handled");

    const adoptedAfterReject = await h.refs.adopted();
    expect(adoptedAfterReject).not.toBeNull();
    if (adoptedAfterReject === null) return;
    await h
      .expectFile("preferences/signals.md", { atCommit: adoptedAfterReject })
      .toContain("- naming:: rejected by owner");
    await h
      .expectFile("core.md", { atCommit: adoptedAfterReject })
      .toNotContain("- naming::");

    expect((await h.tick()).adopted).toBe(true);
    const finalRows = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<QuestionRow>;
    const namingRows = finalRows.filter((row) =>
      row.idempotency_key.includes(":naming:"),
    );
    expect(namingRows).toHaveLength(1);
    expect(namingRows[0]?.status).toBe("answered");

    // PROJECTIONS_ARE_REBUILDABLE: the counter facts are clock-free and
    // re-derive from adopted markdown — wipe the rows outright, then
    // `dome rebuild` restores both (now carrying promoted / rejected
    // states), proving re-derivation rather than mere survival.
    h.projection.raw.run(
      "DELETE FROM facts WHERE predicate = 'dome.preference.topic'",
    );
    await h
      .expectProjection()
      .facts({ predicate: "dome.preference.topic" })
      .toHaveCount(0);
    const rebuild = await h.runCli(["rebuild", "--json"]);
    expect(rebuild.exitCode).toBe(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.preference.topic",
        subjectId: "preferences/signals.md",
      })
      .toHaveCount(2);
    const rebuiltStates = h.projection.raw
      .query<{ object_json: string }, []>(
        "SELECT object_json FROM facts WHERE predicate = 'dome.preference.topic'",
      )
      .all()
      .map((row) => {
        const object = JSON.parse(row.object_json) as { value?: string };
        return (JSON.parse(object.value ?? "{}") as { state?: string }).state;
      })
      .sort();
    expect(rebuiltStates).toEqual(["promoted", "rejected"]);
  },
);
