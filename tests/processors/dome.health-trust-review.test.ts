// dome.health.trust-review — the trust ladder (product review 5, Task 4).
//
// The gardener proposes changes to its own autonomy through the proposal
// review loop: decide-core promotion/dormancy edges, the comment-preserving
// `.dome/config.yaml` promotion edit, and the processor shell (propose-mode
// PatchEffect + owner-needed dormancy question + NEEDS_ARE_LOUD warnings).

import { describe, expect, test } from "bun:test";

import trustReview from "../../assets/extensions/dome.health/processors/trust-review";
import {
  aggregateProposalActivity,
  aggregateRunActivity,
  CONFIG_PATH,
  decideTrustReview,
  grantedAutonomy,
  parsePromotionTarget,
  policyFromConfigBody,
  promoteProcessorGrantInConfig,
  promotionReason,
  promotionSuppression,
  TRUST_REVIEW_PROCESSOR_ID,
  type TrustProposalStats,
  type TrustRunStats,
} from "../../assets/extensions/dome.health/processors/trust-review-shared";
import type {
  DiagnosticEffect,
  PatchEffect,
  QuestionEffect,
} from "../../src/core/effect";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type OperationalProposalRow,
  type OperationalQueryView,
  type OperationalRunRow,
  type Snapshot,
} from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("8888888888888888888888888888888888888888");
const TREE = treeOid("9999999999999999999999999999999999999999");
const ADOPTED: CommitOid = commitOid(
  "7777777777777777777777777777777777777777",
);

// Monday 2026-06-01 05:24 vault-local — the manifest cron.
const FIRED_AT = new Date(2026, 5, 1, 5, 24).toISOString();
const NOW_ISO = new Date(FIRED_AT).toISOString();

const daysAgo = (days: number): string =>
  new Date(new Date(FIRED_AT).getTime() - days * 24 * 60 * 60 * 1000).toISOString();

// ----- decide-core fixtures ---------------------------------------------------

function stats(input: Partial<TrustProposalStats>): TrustProposalStats {
  return Object.freeze({
    processorId: "dome.acme.tidy",
    extensionId: "dome.acme",
    decided: 8,
    applied: 8,
    proposedPaths: Object.freeze(["wiki/notes/a.md"]),
    autonomy: "propose" as const,
    pendingPromotion: false,
    promotionRejectedAt: null,
    ...input,
  });
}

function decide(
  proposalStats: ReadonlyArray<TrustProposalStats>,
  runStats: ReadonlyArray<TrustRunStats> = [],
) {
  return decideTrustReview({ nowIso: NOW_ISO, proposalStats, runStats });
}

describe("decideTrustReview (pure)", () => {
  test("7 decided → no promotion; 8 decided → promotion", () => {
    expect(decide([stats({ decided: 7, applied: 7 })])).toEqual([]);
    const decisions = decide([stats({ decided: 8, applied: 8 })]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "promote",
      processorId: "dome.acme.tidy",
      extensionId: "dome.acme",
      autoPaths: ["wiki/notes/a.md"],
    });
  });

  test("accept rate 0.74 → no; exactly 0.75 → yes", () => {
    expect(decide([stats({ decided: 100, applied: 74 })])).toEqual([]);
    expect(decide([stats({ decided: 8, applied: 6 })])).toHaveLength(1);
  });

  test("already-auto → no; unknown autonomy (unreadable config) → no", () => {
    expect(decide([stats({ autonomy: "auto" })])).toEqual([]);
    expect(decide([stats({ autonomy: "unknown" })])).toEqual([]);
  });

  test("an open pending promotion suppresses re-emission", () => {
    expect(decide([stats({ pendingPromotion: true })])).toEqual([]);
  });

  test("rejected 10 days ago → suppressed; rejected 30 days ago → eligible", () => {
    expect(
      decide([stats({ promotionRejectedAt: daysAgo(10) })]),
    ).toEqual([]);
    expect(
      decide([stats({ promotionRejectedAt: daysAgo(30) })]),
    ).toHaveLength(1);
  });

  test("a processor proposing .dome/config.yaml edits is never promoted", () => {
    expect(
      decide([stats({ proposedPaths: ["wiki/a.md", CONFIG_PATH] })]),
    ).toEqual([]);
  });

  test("trust-review never promotes itself", () => {
    expect(
      decide([stats({ processorId: TRUST_REVIEW_PROCESSOR_ID })]),
    ).toEqual([]);
  });

  test("dormant LLM processor (cost > $0, zero productive) → flagged", () => {
    const decisions = decide(
      [],
      [{ processorId: "dome.agent.sweep", costUsd: 2.4, productive: 0 }],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "flag-dormant",
      processorId: "dome.agent.sweep",
    });
    expect((decisions[0] as { evidence: string }).evidence).toContain("$2.40");
  });

  test("dormant deterministic zero-cost processor → NOT flagged; productive spender → NOT flagged", () => {
    expect(
      decide([], [{ processorId: "dome.graph.links", costUsd: 0, productive: 0 }]),
    ).toEqual([]);
    expect(
      decide([], [{ processorId: "dome.agent.brief", costUsd: 3.1, productive: 5 }]),
    ).toEqual([]);
  });

  test("the promotion evidence round-trips through parsePromotionTarget", () => {
    const reason = promotionReason("dome.acme.tidy", 6, 8);
    expect(reason).toContain("6/8");
    expect(parsePromotionTarget(reason)).toBe("dome.acme.tidy");
    expect(parsePromotionTarget("split oversized page")).toBeNull();
  });
});

// ----- Proposal-row aggregation -----------------------------------------------

function proposalRow(input: {
  readonly processorId: string;
  readonly extensionId?: string;
  readonly reason?: string;
  readonly paths?: ReadonlyArray<string>;
  readonly createdAt?: string;
  readonly status?: "pending" | "applied" | "rejected";
  readonly decidedAt?: string | null;
  readonly id?: number;
}): OperationalProposalRow {
  return Object.freeze({
    id: input.id ?? 1,
    processorId: input.processorId,
    extensionId:
      input.extensionId ??
      input.processorId.split(".").slice(0, 2).join("."),
    reason: input.reason ?? "tidy the notes",
    paths: Object.freeze(input.paths ?? ["wiki/notes/a.md"]),
    createdAt: input.createdAt ?? daysAgo(10),
    status: input.status ?? "pending",
    decidedAt: input.decidedAt ?? null,
  });
}

describe("aggregateProposalActivity", () => {
  test("counts decided/applied by decidedAt within the window; unions paths", () => {
    const rows = [
      proposalRow({ processorId: "dome.acme.tidy", status: "applied", decidedAt: daysAgo(3), paths: ["wiki/a.md"] }),
      proposalRow({ processorId: "dome.acme.tidy", status: "rejected", decidedAt: daysAgo(5), paths: ["wiki/b.md"] }),
      // decided OUTSIDE the 28d window — excluded from counts.
      proposalRow({ processorId: "dome.acme.tidy", status: "applied", decidedAt: daysAgo(40), createdAt: daysAgo(41), paths: ["wiki/c.md"] }),
      // still pending — path counts as activity, not as decided.
      proposalRow({ processorId: "dome.acme.tidy", status: "pending", paths: ["wiki/d.md"] }),
    ];
    const activity = aggregateProposalActivity(rows, daysAgo(28));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      processorId: "dome.acme.tidy",
      extensionId: "dome.acme",
      decided: 2,
      applied: 1,
      proposedPaths: ["wiki/a.md", "wiki/b.md", "wiki/d.md"],
    });
  });

  test("trust-review's own promotion rows are excluded from producer evidence", () => {
    const rows = [
      proposalRow({
        processorId: TRUST_REVIEW_PROCESSOR_ID,
        reason: promotionReason("dome.acme.tidy", 6, 8),
        paths: [CONFIG_PATH],
      }),
    ];
    expect(aggregateProposalActivity(rows, daysAgo(28))).toEqual([]);
  });
});

describe("promotionSuppression", () => {
  test("derives pending + most recent rejection from durable rows (no new state)", () => {
    const rows = [
      proposalRow({
        id: 1,
        processorId: TRUST_REVIEW_PROCESSOR_ID,
        reason: promotionReason("dome.acme.tidy", 6, 8),
        status: "rejected",
        decidedAt: daysAgo(35),
      }),
      proposalRow({
        id: 2,
        processorId: TRUST_REVIEW_PROCESSOR_ID,
        reason: promotionReason("dome.acme.tidy", 7, 9),
        status: "rejected",
        decidedAt: daysAgo(10),
      }),
      proposalRow({
        id: 3,
        processorId: TRUST_REVIEW_PROCESSOR_ID,
        reason: promotionReason("dome.other.thing", 8, 8),
        status: "pending",
      }),
    ];
    expect(promotionSuppression(rows, "dome.acme.tidy")).toEqual({
      pending: false,
      rejectedAt: daysAgo(10),
    });
    expect(promotionSuppression(rows, "dome.other.thing")).toEqual({
      pending: true,
      rejectedAt: null,
    });
    expect(promotionSuppression(rows, "dome.unseen")).toEqual({
      pending: false,
      rejectedAt: null,
    });
  });
});

// ----- The comment-preserving promotion edit ------------------------------------

const EXPLICIT_CONFIG = [
  "# owner note: keep dome.acme narrow",
  "extensions:",
  "  dome.acme:",
  "    enabled: true",
  "    # grant comment: hand-tuned",
  "    grant:",
  '      read: ["wiki/**/*.md"]',
  '      patch.propose: ["wiki/**/*.md"]',
  "",
].join("\n");

describe("promoteProcessorGrantInConfig (yaml Document edit)", () => {
  test("explicit grant block: adds a per-processor replacement grant, preserves comments AND the other grants", () => {
    const result = promoteProcessorGrantInConfig({
      configBody: EXPLICIT_CONFIG,
      extensionId: "dome.acme",
      processorId: "dome.acme.tidy",
      autoPaths: ["wiki/notes/a.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Hand comments survive the Document edit.
    expect(result.content).toContain("# owner note: keep dome.acme narrow");
    expect(result.content).toContain("# grant comment: hand-tuned");

    const policy = policyFromConfigBody(result.content);
    expect(policy).not.toBeNull();
    if (policy === null) return;
    // The promoted processor now auto-applies the path...
    expect(
      grantedAutonomy({
        policy,
        extensionId: "dome.acme",
        processorId: "dome.acme.tidy",
        paths: ["wiki/notes/a.md"],
      }),
    ).toBe("auto");
    // ...while keeping its previous grants (the replacement carried them over).
    const promoted = policy.grantsForProcessor("dome.acme", "dome.acme.tidy");
    expect(promoted.some((c) => c.kind === "read")).toBe(true);
    expect(promoted.some((c) => c.kind === "patch.propose")).toBe(true);
    // Sibling processors keep riding the untouched extension grant.
    expect(
      grantedAutonomy({
        policy,
        extensionId: "dome.acme",
        processorId: "dome.acme.other",
        paths: ["wiki/notes/a.md"],
      }),
    ).toBe("propose");
  });

  test("grants: standard preset: materializes the shipped defaults before opting the extension out", () => {
    const body = [
      "# top comment",
      "grants: standard",
      "",
      "extensions:",
      "  dome.agent:",
      "    enabled: true",
      "  dome.health:",
      "    enabled: true",
      "",
    ].join("\n");
    const result = promoteProcessorGrantInConfig({
      configBody: body,
      extensionId: "dome.agent",
      processorId: "dome.agent.consolidate",
      // core.md is deliberately propose-only in the shipped defaults — the
      // promotion mechanics are what is under test here.
      autoPaths: ["core.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("# top comment");

    const policy = policyFromConfigBody(result.content);
    expect(policy).not.toBeNull();
    if (policy === null) return;
    // The target is promoted...
    expect(
      grantedAutonomy({
        policy,
        extensionId: "dome.agent",
        processorId: "dome.agent.consolidate",
        paths: ["core.md"],
      }),
    ).toBe("auto");
    // ...its other bundle-grant capabilities were carried into the
    // replacement grant...
    const promoted = policy.grantsForProcessor("dome.agent", "dome.agent.consolidate");
    expect(promoted.some((c) => c.kind === "model.invoke")).toBe(true);
    // ...the materialized per-processor preset defaults survive (the opt-out
    // would otherwise strip the deterministic indexers' replacement grants)...
    const briefIndex = policy.grantsForProcessor("dome.agent", "dome.agent.brief-index");
    expect(briefIndex.some((c) => c.kind === "graph.write")).toBe(true);
    // ...and OTHER extensions still ride the preset untouched.
    const reportCard = policy.grantsForProcessor("dome.health", "dome.health.report-card");
    expect(reportCard.some((c) => c.kind === "patch.auto")).toBe(true);
  });

  test("refuses to emit an edit it cannot validate", () => {
    expect(
      promoteProcessorGrantInConfig({
        configBody: "extensions:\n  dome.acme:\n    enabled: true\n",
        extensionId: "dome.acme",
        processorId: "dome.acme.tidy",
        autoPaths: ["wiki/a.md"],
      }).ok,
      // no explicit grant and no grants: standard preset — nothing to promote from
    ).toBe(false);
    expect(
      promoteProcessorGrantInConfig({
        configBody: EXPLICIT_CONFIG,
        extensionId: "dome.missing",
        processorId: "dome.missing.x",
        autoPaths: ["wiki/a.md"],
      }).ok,
    ).toBe(false);
    expect(
      promoteProcessorGrantInConfig({
        configBody: EXPLICIT_CONFIG,
        extensionId: "dome.acme",
        processorId: "dome.acme.tidy",
        autoPaths: [],
      }).ok,
    ).toBe(false);
  });
});

// ----- Processor shell ---------------------------------------------------------

const SHELL_CONFIG = EXPLICIT_CONFIG;

function run(input: {
  readonly processorId: string;
  readonly status?: OperationalRunRow["status"];
  readonly costUsd?: number | null;
  readonly effectCount?: number;
}): OperationalRunRow {
  return Object.freeze({
    id: `run-${input.processorId}-${Math.random()}`,
    proposalId: null,
    processorId: input.processorId,
    processorVersion: "1.0.0",
    phase: "garden",
    inputCommit: String(ADOPTED),
    outputCommit: null,
    status: input.status ?? "succeeded",
    costUsd: input.costUsd ?? null,
    durationMs: 100,
    effectCount: input.effectCount ?? 0,
    error: null,
    triggerKind: "schedule",
    startedAt: daysAgo(2),
    finishedAt: daysAgo(2),
  });
}

/** 8 decided (6 applied, 2 rejected) inside the window → promotable. */
function promotableRows(): OperationalProposalRow[] {
  const rows: OperationalProposalRow[] = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push(
      proposalRow({
        id: i + 1,
        processorId: "dome.acme.tidy",
        status: "applied",
        decidedAt: daysAgo(3 + i),
        createdAt: daysAgo(4 + i),
      }),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    rows.push(
      proposalRow({
        id: 10 + i,
        processorId: "dome.acme.tidy",
        status: "rejected",
        decidedAt: daysAgo(6 + i),
        createdAt: daysAgo(7 + i),
      }),
    );
  }
  return rows;
}

function viewOf(inputs: {
  readonly proposals?: ReadonlyArray<OperationalProposalRow>;
  readonly runs?: ReadonlyArray<OperationalRunRow>;
}): OperationalQueryView {
  return Object.freeze({
    outbox: () => Object.freeze([]),
    quarantines: () => Object.freeze([]),
    orphanRuns: () => Object.freeze([]),
    runs: () => Object.freeze([...(inputs.runs ?? [])]),
    questions: () => Object.freeze([]),
    ...(inputs.proposals !== undefined
      ? { proposals: () => Object.freeze([...(inputs.proposals ?? [])]) }
      : {}),
  });
}

async function runTrustReview(
  files: Readonly<Record<string, string>>,
  operational: OperationalQueryView | undefined,
): Promise<{
  readonly patches: ReadonlyArray<PatchEffect>;
  readonly questions: ReadonlyArray<QuestionEffect>;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-trust-review",
    signal: new AbortController().signal,
    now: new Date(FIRED_AT),
    input: { kind: "schedule", cron: "24 5 * * 1", firedAt: FIRED_AT },
    ...(operational !== undefined ? { operational } : {}),
  });
  const effects = await trustReview.run(ctx);
  return {
    patches: effects.filter((e): e is PatchEffect => e.kind === "patch"),
    questions: effects.filter((e): e is QuestionEffect => e.kind === "question"),
    diagnostics: effects.filter(
      (e): e is DiagnosticEffect => e.kind === "diagnostic",
    ),
  };
}

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-06-01T05:00:00.000Z",
            lastHumanChangedAt: "2026-06-01T05:00:00.000Z",
          },
  });
}

describe("dome.health.trust-review (processor shell)", () => {
  test("a promotable producer yields ONE propose-mode config patch with parseable evidence", async () => {
    const { patches, diagnostics } = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      viewOf({ proposals: promotableRows() }),
    );
    expect(diagnostics).toEqual([]);
    expect(patches).toHaveLength(1);
    const patch = patches[0]!;
    expect(patch.mode).toBe("propose");
    expect(patch.changes.map((c) => String(c.path))).toEqual([CONFIG_PATH]);
    expect(parsePromotionTarget(patch.reason)).toBe("dome.acme.tidy");
    expect(patch.reason).toContain("6/8");

    // The proposed config actually promotes the producer.
    const change = patch.changes[0]!;
    if (change.kind !== "write") throw new Error("expected a write change");
    const policy = policyFromConfigBody(change.content);
    expect(policy).not.toBeNull();
    expect(
      grantedAutonomy({
        policy,
        extensionId: "dome.acme",
        processorId: "dome.acme.tidy",
        paths: ["wiki/notes/a.md"],
      }),
    ).toBe("auto");
  });

  test("an open pending promotion for the same target suppresses re-emission (idempotence)", async () => {
    const rows = [
      ...promotableRows(),
      proposalRow({
        id: 99,
        processorId: TRUST_REVIEW_PROCESSOR_ID,
        reason: promotionReason("dome.acme.tidy", 6, 8),
        paths: [CONFIG_PATH],
        status: "pending",
      }),
    ];
    const { patches } = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      viewOf({ proposals: rows }),
    );
    expect(patches).toEqual([]);
  });

  test("a dormant LLM processor raises ONE owner-needed question with a stable idempotency key", async () => {
    const runs = [
      run({ processorId: "dome.agent.sweep", costUsd: 1.25, effectCount: 0 }),
      run({ processorId: "dome.agent.sweep", costUsd: 0.75, effectCount: 0 }),
      // deterministic zero-cost idler — the report card's concern, not ours
      run({ processorId: "dome.graph.links", costUsd: null, effectCount: 0 }),
      // productive spender — fine
      run({ processorId: "dome.agent.brief", costUsd: 2.0, effectCount: 3 }),
    ];
    const { questions } = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      viewOf({ proposals: [], runs }),
    );
    expect(questions).toHaveLength(1);
    const question = questions[0]!;
    expect(question.idempotencyKey).toBe(
      "dome.health.trust-review:dormant:dome.agent.sweep",
    );
    expect(question.question).toContain("$2.00");
    expect(question.metadata?.automationPolicy).toBe("owner-needed");
  });

  test("missing views are LOUD: proposals view absent → warning; run stats still flag dormancy", async () => {
    const { patches, questions, diagnostics } = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      viewOf({
        runs: [run({ processorId: "dome.agent.sweep", costUsd: 1.0, effectCount: 0 })],
      }),
    );
    expect(patches).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(
      diagnostics.some(
        (d) => d.code === "dome.health.trust-review-proposals-view-missing",
      ),
    ).toBe(true);
  });

  test("no operational view at all → two warnings, nothing emitted", async () => {
    const { patches, questions, diagnostics } = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      undefined,
    );
    expect(patches).toEqual([]);
    expect(questions).toEqual([]);
    expect(diagnostics.map((d) => d.code).sort()).toEqual([
      "dome.health.trust-review-proposals-view-missing",
      "dome.health.trust-review-runs-view-missing",
    ]);
  });

  test("unreadable config is LOUD and no promotion is proposed", async () => {
    const { patches, diagnostics } = await runTrustReview(
      {},
      viewOf({ proposals: promotableRows() }),
    );
    expect(patches).toEqual([]);
    expect(
      diagnostics.some(
        (d) => d.code === "dome.health.trust-review-config-unreadable",
      ),
    ).toBe(true);
  });

  test("a quiet vault (no promotion volume) never reads config — no weekly nag", async () => {
    // Fresh-init posture: proposals view present but empty, config absent from
    // the snapshot. The config read is a need only once a producer clears
    // PROMOTE_MIN_DECIDED, so no diagnostic may fire here.
    const quiet = await runTrustReview({}, viewOf({ proposals: [] }));
    expect(quiet.patches).toEqual([]);
    expect(quiet.diagnostics).toEqual([]);

    // Below-volume traffic (a handful of decided rows) is still quiet.
    const belowVolume = await runTrustReview(
      {},
      viewOf({ proposals: promotableRows().slice(0, 4) }),
    );
    expect(
      belowVolume.diagnostics.filter(
        (d) => d.code === "dome.health.trust-review-config-unreadable",
      ),
    ).toEqual([]);
  });

  test("re-running with unchanged inputs emits the identical patch (dedupe-key idempotence upstream)", async () => {
    const first = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      viewOf({ proposals: promotableRows() }),
    );
    const second = await runTrustReview(
      { [CONFIG_PATH]: SHELL_CONFIG },
      viewOf({ proposals: promotableRows() }),
    );
    expect(second.patches).toHaveLength(1);
    const c1 = first.patches[0]!.changes[0]!;
    const c2 = second.patches[0]!.changes[0]!;
    if (c1.kind !== "write" || c2.kind !== "write") throw new Error("writes expected");
    expect(c2.content).toBe(c1.content);
    expect(second.patches[0]!.reason).toBe(first.patches[0]!.reason);
  });
});

// ----- aggregateRunActivity -----------------------------------------------------

describe("aggregateRunActivity", () => {
  test("sums cost and counts productive (succeeded with ≥1 effect)", () => {
    const activity = aggregateRunActivity([
      run({ processorId: "dome.b", costUsd: 0.5, effectCount: 0 }),
      run({ processorId: "dome.b", costUsd: 0.25, effectCount: 2 }),
      run({ processorId: "dome.b", status: "failed", costUsd: 0.25 }),
      run({ processorId: "dome.a", costUsd: null, effectCount: 0 }),
    ]);
    expect(activity.map((s) => s.processorId)).toEqual(["dome.a", "dome.b"]);
    expect(activity[1]).toMatchObject({ productive: 1 });
    expect(activity[1]!.costUsd).toBeCloseTo(1.0);
  });
});
