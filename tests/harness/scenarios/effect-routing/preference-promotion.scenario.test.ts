// scenarios/effect-routing/preference-promotion.scenario.test.ts
//
// Preference promotion end-to-end (memory-quality M5,
// docs/wiki/specs/preferences.md): owner-correction signals accrue in
// preferences/signals.md → the deterministic counter emits rebuildable
// dome.preference.topic facts → 3 same-sign signals within 30 days raise ONE
// owner-needed promotion question → resolving `promote` lands the rule in
// core.md's promoted-preferences block through the gated answer handler
// (narrow per-processor grant) → the counter sees the promoted state and
// stays quiet. Rejecting a second topic appends the owner tombstone and
// retires it. The lifecycle's revival legs are covered too: demote →
// re-accrued identical corrections RE-fire the promotion question (the
// signal-epoch key salt — answered rows settle an episode, not the topic),
// and a second scenario proves keep → a later decay episode RE-fires the
// demotion question. The dome.agent bundle runs WITHOUT a model provider —
// the preference processors are deterministic; the agent loops no-op.

import { expect } from "bun:test";

import { fnv1aHex } from "../../../../assets/extensions/dome.agent/lib/preferences-shared";
import { readBlob } from "../../../../src/git";
import { scenario } from "../../index";

const CANDIDATE_RULE = "meeting notes go under notes/, not entities/";

// Bundle-level grant mirrors the shipped defaults (core.md read-only) plus
// the per-processor replacement grant for the promotion answer handler —
// the canonical shape from preferences.md §"Two gated writers, block-scoped".
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
        - "sources/calendar/*.md"
        - "core.md"
        - "preferences/signals.md"
      patch.auto:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "index.md"
        - "log.md"
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

    // Promote `filing`: the answer handler — the gated writer of core.md's
    // promoted-preferences block — splices the rule into the generated block.
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

    // ----- WS1 pruning: decay → demotion question → demote round trip -----
    // A much newer signal elsewhere moves the deterministic reference date;
    // filing's promoted rule decays past the 90-day freshness horizon
    // (confidence 0 < the 0.15 floor) and raises ONE owner-needed demotion
    // question. Resolving `demote` splices the entry out of core.md's block
    // and records the re-promotable minus signal — deliberately NOT the
    // rejection tombstone.
    const adoptedBeforeDecay = await h.refs.adopted();
    expect(adoptedBeforeDecay).not.toBeNull();
    if (adoptedBeforeDecay === null) return;
    const signalsNow = await readBlob({
      path: h.vaultPath,
      commit: adoptedBeforeDecay,
      filepath: "preferences/signals.md",
    });
    expect(signalsNow).not.toBeNull();
    await h.userCommit({
      files: {
        "preferences/signals.md": `${(signalsNow ?? "").replace(/\s+$/, "")}\n- 2026-09-15 + tagging:: tag sparingly\n`,
      },
      message: "months pass: a much later signal moves the reference date",
    });
    expect((await h.tick()).adopted).toBe(true);

    const decayRows = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<QuestionRow>;
    const demotionRows = decayRows.filter((row) =>
      row.idempotency_key.startsWith("dome.agent.preference-demotion:"),
    );
    expect(demotionRows).toHaveLength(1);
    const demotionRow = demotionRows[0];
    expect(demotionRow?.status).toBe("open");
    expect(demotionRow?.idempotency_key).toContain(":filing:");
    expect(demotionRow?.metadata).toEqual(
      expect.objectContaining({
        automationPolicy: "owner-needed",
        confidence: 0,
      }),
    );
    if (demotionRow === undefined) return;

    const demote = await h.runCli([
      "resolve",
      String(demotionRow.id),
      "demote",
      "--json",
    ]);
    expect(demote.exitCode).toBe(0);
    expect(
      (JSON.parse(demote.stdout) as { handlers: { status: string } }).handlers
        .status,
    ).toBe("handled");

    const adoptedAfterDemote = await h.refs.adopted();
    expect(adoptedAfterDemote).not.toBeNull();
    if (adoptedAfterDemote === null) return;
    await h
      .expectFile("core.md", { atCommit: adoptedAfterDemote })
      .toNotContain("- filing::");
    await h
      .expectFile("core.md", { atCommit: adoptedAfterDemote })
      .toContain("<!-- dome.agent:promoted-preferences:start -->");
    await h
      .expectFile("preferences/signals.md", { atCommit: adoptedAfterDemote })
      .toContain("- filing:: demoted by owner (confidence decayed)");

    // Demoted ≠ rejected: the counter now reads filing as `building` (the
    // topic can re-earn promotion), and no fresh demotion question appears
    // for the now-absent entry.
    expect((await h.tick()).adopted).toBe(true);
    const finalDemotionRows = (
      JSON.parse(
        (await h.runCli(["inspect", "questions", "--json"])).stdout,
      ) as ReadonlyArray<QuestionRow>
    ).filter((row) =>
      row.idempotency_key.startsWith("dome.agent.preference-demotion:"),
    );
    expect(finalDemotionRows).toHaveLength(1);
    expect(finalDemotionRows[0]?.status).toBe("answered");
    const filingState = h.projection.raw
      .query<{ object_json: string }, []>(
        "SELECT object_json FROM facts WHERE predicate = 'dome.preference.topic'",
      )
      .all()
      .map((row) => {
        const object = JSON.parse(row.object_json) as { value?: string };
        return JSON.parse(object.value ?? "{}") as {
          topic?: string;
          state?: string;
        };
      })
      .find((value) => value.topic === "filing");
    expect(filingState?.state).toBe("building");

    // ----- Re-accrual after demote: the promotion question RE-fires -----
    // The first filing promote row is answered, and answered rows are
    // permanent per idempotency key. The re-accrual epoch's newer signal
    // dates salt a FRESH key, so the identical canonical phrasing asks
    // again — without the salt this leg dead-ended: `candidate` state was
    // reachable but the question never re-fired.
    const adoptedAfterRoundTrip = await h.refs.adopted();
    expect(adoptedAfterRoundTrip).not.toBeNull();
    if (adoptedAfterRoundTrip === null) return;
    const signalsAfterDemote = await readBlob({
      path: h.vaultPath,
      commit: adoptedAfterRoundTrip,
      filepath: "preferences/signals.md",
    });
    expect(signalsAfterDemote).not.toBeNull();
    // Re-accrual dates strictly after everything already in the file: the
    // fixed 2026-09-15 tagging line and the wall-clock-dated demote signal.
    const reAccrualBase = Math.max(
      Date.now(),
      Date.parse("2026-09-15T00:00:00.000Z"),
    );
    const reAccrualDate = (days: number): string =>
      new Date(reAccrualBase + days * 86_400_000).toISOString().slice(0, 10);
    await h.userCommit({
      files: {
        "preferences/signals.md": [
          (signalsAfterDemote ?? "").replace(/\s+$/, ""),
          `- ${reAccrualDate(10)} + filing:: ${CANDIDATE_RULE}`,
          `- ${reAccrualDate(14)} + filing:: ${CANDIDATE_RULE}`,
          `- ${reAccrualDate(18)} + filing:: ${CANDIDATE_RULE}`,
          "",
        ].join("\n"),
      },
      message: "the demoted preference re-accrues identical corrections",
    });
    expect((await h.tick()).adopted).toBe(true);

    const reAccrualRows = (
      JSON.parse(
        (await h.runCli(["inspect", "questions", "--json"])).stdout,
      ) as ReadonlyArray<QuestionRow>
    ).filter(
      (row) =>
        row.idempotency_key.startsWith("dome.agent.preference-promotion:") &&
        row.idempotency_key.includes(":filing:"),
    );
    expect(reAccrualRows).toHaveLength(2);
    expect(reAccrualRows.map((row) => row.status).sort()).toEqual([
      "answered",
      "open",
    ]);
    // The permanent answered row is the FIRST episode's key, untouched.
    expect(
      reAccrualRows.find((row) => row.status === "answered")?.idempotency_key,
    ).toBe(filing.idempotency_key);
    const reFired = reAccrualRows.find((row) => row.status === "open");
    expect(reFired).toBeDefined();
    if (reFired === undefined) return;
    expect(reFired.idempotency_key).not.toBe(filing.idempotency_key);
    // Same topic, same rule hash — only the trailing epoch segment differs
    // from the answered first-episode key.
    expect(
      reFired.idempotency_key.startsWith(
        `dome.agent.preference-promotion:filing:${fnv1aHex(CANDIDATE_RULE)}:`,
      ),
    ).toBe(true);
    expect(reFired.question).toContain(CANDIDATE_RULE);

    // Promote again — the lifecycle's full circle: the rule lands back in
    // core.md's promoted block through the same gated writer.
    const rePromote = await h.runCli([
      "resolve",
      String(reFired.id),
      "promote",
      "--json",
    ]);
    expect(rePromote.exitCode).toBe(0);
    expect(
      (JSON.parse(rePromote.stdout) as { handlers: { status: string } })
        .handlers.status,
    ).toBe("handled");
    const adoptedAfterRePromote = await h.refs.adopted();
    expect(adoptedAfterRePromote).not.toBeNull();
    if (adoptedAfterRePromote === null) return;
    await h
      .expectFile("core.md", { atCommit: adoptedAfterRePromote })
      .toContain(`- filing:: ${CANDIDATE_RULE} (confidence 0.`);

    // PROJECTIONS_ARE_REBUILDABLE: the counter facts are clock-free and
    // re-derive from adopted markdown — wipe the rows outright, then
    // `dome rebuild` restores all three topics (filing re-promoted, naming
    // rejected, tagging still building), proving re-derivation rather than
    // mere survival. Runs LAST: rebuild rehydrates the questions projection
    // from current emission + the durable answers store, so answered rows
    // for questions the snapshot no longer emits do not survive it — the
    // lifecycle legs above must see the real answered-row permanence.
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
      .toHaveCount(3);
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
    expect(rebuiltStates).toEqual(["building", "promoted", "rejected"]);
  },
);

scenario(
  {
    name: "effect-routing: keep settles one decay episode; the epoch-salted key re-asks when the rule decays again",
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
    // Wall-clock-relative dates: the keep answer's reaffirmation signal is
    // dated `answeredAt` (today), so the episode timeline is built around
    // today — past dates for the first decay, a future signal for the second.
    const DAY_MS = 86_400_000;
    const isoAt = (ms: number): string =>
      new Date(ms).toISOString().slice(0, 10);
    const daysAgo = (days: number): string => isoAt(Date.now() - days * DAY_MS);
    const daysFromNow = (days: number): string =>
      isoAt(Date.now() + days * DAY_MS);

    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // Decay episode ONE: a rule promoted long ago whose signals sit > 90
    // days behind the file's newest signal date — freshness 0, confidence 0.
    await h.userCommit({
      files: {
        "core.md": [
          "# Core memory",
          "",
          "## Standing preferences",
          "",
          "<!-- dome.agent:promoted-preferences:start -->",
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          "<!-- dome.agent:promoted-preferences:end -->",
          "",
        ].join("\n"),
        "preferences/signals.md": [
          `- ${daysAgo(210)} + filing:: meeting notes go under notes/`,
          `- ${daysAgo(205)} + filing:: meeting notes go under notes/`,
          `- ${daysAgo(200)} + filing:: ${CANDIDATE_RULE}`,
          `- ${daysAgo(95)} + tagging:: tag sparingly`,
          "",
        ].join("\n"),
      },
      message: "a long-promoted preference has gone stale",
    });
    expect((await h.tick()).adopted).toBe(true);

    const episodeOneRows = (
      JSON.parse(
        (await h.runCli(["inspect", "questions", "--json"])).stdout,
      ) as ReadonlyArray<QuestionRow>
    ).filter((row) =>
      row.idempotency_key.startsWith("dome.agent.preference-demotion:"),
    );
    expect(episodeOneRows).toHaveLength(1);
    const episodeOne = episodeOneRows[0];
    expect(episodeOne?.status).toBe("open");
    // Pure freshness decay: the stale-form epoch pins the last signal date.
    expect(episodeOne?.idempotency_key).toMatch(
      /^dome\.agent\.preference-demotion:filing:[0-9a-f]{8}:stale-\d{4}-\d{2}-\d{2}$/,
    );
    if (episodeOne === undefined) return;

    // keep → the handler appends a today-dated reaffirmation. Freshness
    // resets, confidence clears the floor, and no fresh question fires: the
    // answered row settles THIS episode, and the topic is no longer a
    // demotion candidate anyway.
    const keep = await h.runCli([
      "resolve",
      String(episodeOne.id),
      "keep",
      "--json",
    ]);
    expect(keep.exitCode).toBe(0);
    expect(
      (JSON.parse(keep.stdout) as { handlers: { status: string } }).handlers
        .status,
    ).toBe("handled");
    const adoptedAfterKeep = await h.refs.adopted();
    expect(adoptedAfterKeep).not.toBeNull();
    if (adoptedAfterKeep === null) return;
    await h
      .expectFile("preferences/signals.md", { atCommit: adoptedAfterKeep })
      .toContain(`+ filing:: ${CANDIDATE_RULE}`);
    await h
      .expectFile("core.md", { atCommit: adoptedAfterKeep })
      .toContain(`- filing:: ${CANDIDATE_RULE} (confidence 0.44)`);
    expect((await h.tick()).adopted).toBe(true);
    const afterKeep = (
      JSON.parse(
        (await h.runCli(["inspect", "questions", "--json"])).stdout,
      ) as ReadonlyArray<QuestionRow>
    ).filter((row) =>
      row.idempotency_key.startsWith("dome.agent.preference-demotion:"),
    );
    expect(afterKeep).toHaveLength(1);
    expect(afterKeep[0]?.status).toBe("answered");

    // Decay episode TWO: the reaffirmation itself ages past the freshness
    // horizon (a much later signal elsewhere moves the deterministic
    // reference date). The kept rule's newer signal date salts a FRESH key,
    // so the demotion question RE-fires — before the salt, the answered
    // keep row suppressed decay review for this rule permanently.
    const signalsAfterKeep = await readBlob({
      path: h.vaultPath,
      commit: adoptedAfterKeep,
      filepath: "preferences/signals.md",
    });
    expect(signalsAfterKeep).not.toBeNull();
    await h.userCommit({
      files: {
        "preferences/signals.md": `${(signalsAfterKeep ?? "").replace(/\s+$/, "")}\n- ${daysFromNow(95)} + tagging:: tag sparingly\n`,
      },
      message: "months pass again: the kept rule decays a second time",
    });
    expect((await h.tick()).adopted).toBe(true);

    const episodeTwoRows = (
      JSON.parse(
        (await h.runCli(["inspect", "questions", "--json"])).stdout,
      ) as ReadonlyArray<QuestionRow>
    ).filter((row) =>
      row.idempotency_key.startsWith("dome.agent.preference-demotion:"),
    );
    expect(episodeTwoRows).toHaveLength(2);
    expect(episodeTwoRows.map((row) => row.status).sort()).toEqual([
      "answered",
      "open",
    ]);
    const episodeTwo = episodeTwoRows.find((row) => row.status === "open");
    expect(episodeTwo).toBeDefined();
    // Same topic, same rule hash, a NEW stale epoch (the keep line's date).
    expect(episodeTwo?.idempotency_key).toMatch(
      /^dome\.agent\.preference-demotion:filing:[0-9a-f]{8}:stale-\d{4}-\d{2}-\d{2}$/,
    );
    expect(episodeTwo?.idempotency_key).not.toBe(episodeOne.idempotency_key);
  },
);
