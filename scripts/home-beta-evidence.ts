#!/usr/bin/env bun

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { valid as validSemver } from "semver";
import { z } from "zod";

export const HOME_BETA_PROTOCOL = "dome.home.beta-protocol/2026-07-15.1" as const;
export const HOME_BETA_EVIDENCE_SCHEMA = "dome.home.beta-evidence/v1" as const;
export const HOME_BETA_VALIDATION_SCHEMA = "dome.home.beta-evidence-validation/v1" as const;
export const HOME_BETA_REPORT_SCHEMA = "dome.home.beta-evidence-report/v1" as const;
const HOME_BETA_COMMAND_SCHEMA = "dome.home.beta-command/v1" as const;
const MAX_PACKET_BYTES = 64 * 1024;
const MIN_AGGREGATE_PACKETS = 5;
const MAX_AGGREGATE_PACKETS = 100;

export const HOME_BETA_STEP_KEYS = Object.freeze([
  "install",
  "vault-start",
  "pair",
  "concurrent-use",
  "mutation-admission",
  "external-edit",
  "restart-reconciliation",
  "offline-replay",
  "revoke-isolation",
  "backup-upgrade-rollback",
  "blank-host-restore",
  "projection-rebuild-audit",
] as const);

const reasonOrder = Object.freeze([
  "consent-not-attested",
  "external-owner-not-attested",
  "developer-intervention",
  "journey-step-not-ok",
  "scheduled-observation-not-ok",
  "capture-not-ok",
  "capture-loss",
  "capture-duplication",
  "restart-reconcile-not-ok",
  "readiness-not-ok",
  "mutation-queue-not-ok",
  "device-outcome-not-ok",
  "recovery-outcome-not-ok",
  "platform-outcome-not-ok",
  "model-cost-not-measured",
  "transcription-cost-unavailable",
] as const);

type HomeBetaNonqualificationReason = typeof reasonOrder[number];
type HomeBetaBlocker =
  | "one-or-more-nonqualifying-packets"
  | "operator-review-required";
type CommandErrorCode =
  | "usage"
  | "input-unavailable"
  | "input-not-direct"
  | "input-too-large"
  | "input-unstable"
  | "invalid-json"
  | "invalid-packet"
  | "release-mismatch"
  | "version-mismatch"
  | "duplicate-packet"
  | "input-count"
  | "internal-failure";

const boundedCount = z.number().int().nonnegative().max(1_000_000);
const microUsd = z.number().int().nonnegative().max(1_000_000_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const productVersion = z.string().refine((value) =>
  value === value.trim() && !value.startsWith("v") && validSemver(value) !== null
);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const majorVersion = z.number().int().min(1).max(999);

const PROTOCOL_TIMEOUT_MS = Object.freeze({
  journeyStep: 900_000,
  installToPairedAsk: 900_000,
  generationRead: 30_000,
  captureLocal: 10_000,
  captureCommit: 120_000,
  captureAdopt: 180_000,
  restartReconcile: 300_000,
  readiness: 300_000,
  device: 120_000,
  recovery: 900_000,
  platform: 900_000,
});

const completedOutcomeSchema = (
  outcome: "ok" | "timeout" | "failed",
  timeoutMs: number,
) => z.object({
  outcome: z.literal(outcome),
  durationMs: outcome === "timeout"
    ? z.literal(timeoutMs)
    : z.number().int().nonnegative().max(timeoutMs),
}).strict();

const timedOutcomeSchema = (timeoutMs: number) => z.discriminatedUnion("outcome", [
  completedOutcomeSchema("ok", timeoutMs),
  completedOutcomeSchema("timeout", timeoutMs),
  completedOutcomeSchema("failed", timeoutMs),
  z.object({ outcome: z.literal("not-run"), durationMs: z.null() }).strict(),
]);

type TimedOutcome =
  | Readonly<{ outcome: "ok" | "timeout" | "failed"; durationMs: number }>
  | Readonly<{ outcome: "not-run"; durationMs: null }>;

const costSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("run-ledger"), microUsd }).strict(),
  z.object({ source: z.literal("provider-receipt"), microUsd }).strict(),
  z.object({ source: z.literal("not-used"), microUsd: z.literal(0) }).strict(),
  z.object({ source: z.literal("unavailable"), microUsd: z.null() }).strict(),
]);

const captureSchema = z.object({
  "start-to-local": timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.captureLocal),
  "start-to-commit": timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.captureCommit),
  "start-to-adopt": timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.captureAdopt),
  lostLogicalCaptures: z.number().int().min(0).max(1),
  duplicateLogicalCaptures: boundedCount,
}).strict().superRefine((capture, context) => {
  const local = capture["start-to-local"];
  const commit = capture["start-to-commit"];
  const adopt = capture["start-to-adopt"];
  if (commit.outcome === "ok" && local.outcome !== "ok") {
    context.addIssue({ code: "custom", message: "commit requires local success" });
  }
  if (adopt.outcome === "ok" && (local.outcome !== "ok" || commit.outcome !== "ok")) {
    context.addIssue({ code: "custom", message: "adopt requires prior success" });
  }
  if (local.outcome !== "ok" && (commit.outcome !== "not-run" || adopt.outcome !== "not-run")) {
    context.addIssue({ code: "custom", message: "failed local capture must stop later clocks" });
  }
  if (local.outcome === "ok" && commit.outcome !== "ok" && adopt.outcome !== "not-run") {
    context.addIssue({ code: "custom", message: "failed commit must stop adoption clock" });
  }
  if (local.outcome === "ok" && commit.outcome !== "not-run" &&
    local.durationMs > commit.durationMs) {
    context.addIssue({ code: "custom", message: "capture clocks are not monotonic" });
  }
  if (commit.outcome === "ok" && adopt.outcome !== "not-run" &&
    commit.durationMs > adopt.durationMs) {
    context.addIssue({ code: "custom", message: "capture clocks are not monotonic" });
  }
});

const stepsSchema = z.object(Object.fromEntries(
  HOME_BETA_STEP_KEYS.map((key) => [key, timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.journeyStep)]),
) as unknown as Record<typeof HOME_BETA_STEP_KEYS[number], z.ZodType<TimedOutcome>>).strict();

const timedRecordSchema = <Keys extends readonly [string, ...string[]]>(
  keys: Keys,
  outcomeSchema: z.ZodType<TimedOutcome>,
) => z.object(
  Object.fromEntries(keys.map((key) => [key, outcomeSchema])) as {
    [Key in Keys[number]]: z.ZodType<TimedOutcome>;
  },
).strict();

const DEVICE_OUTCOME_KEYS = [
  "desktop-pair",
  "phone-pair",
  "phone-revoke",
  "revoked-unauthorized",
  "desktop-authorized",
] as const;
const deviceOutcomeSchema = timedRecordSchema(
  DEVICE_OUTCOME_KEYS,
  timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.device),
);

const RECOVERY_OUTCOME_KEYS = [
  "backup",
  "migration",
  "rollback",
  "restore",
] as const;
const recoveryOutcomeSchema = timedRecordSchema(
  RECOVERY_OUTCOME_KEYS,
  timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.recovery),
);

const PLATFORM_OUTCOME_KEYS = [
  "install",
  "offline",
  "update",
  "accessibility",
] as const;
const platformOutcomeSchema = timedRecordSchema(
  PLATFORM_OUTCOME_KEYS,
  timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.platform),
);

const mutationQueueSchema = z.object({
  scheduled: boundedCount,
  success: boundedCount,
  timeout: boundedCount,
  failed: boundedCount,
  notRun: boundedCount,
  saturationEvents: boundedCount,
  conflictEvents: boundedCount,
  retryAttempts: boundedCount,
}).strict().superRefine((queue, context) => {
  if (queue.scheduled !== queue.success + queue.timeout + queue.failed + queue.notRun) {
    context.addIssue({ code: "custom", message: "mutation queue counts must partition scheduled" });
  }
});

export const homeBetaEvidenceSchema = z.object({
  schema: z.literal(HOME_BETA_EVIDENCE_SCHEMA),
  protocol: z.literal(HOME_BETA_PROTOCOL),
  product: z.object({
    version: productVersion,
    target: z.literal("darwin-arm64"),
    distributionReceiptSha256: sha256,
  }).strict(),
  environment: z.object({
    date: dateOnly,
    macosMajor: majorVersion,
    iosMajor: majorVersion.nullable(),
    chromiumMajor: majorVersion.nullable(),
  }).strict(),
  attestations: z.object({
    consented: z.boolean(),
    externalOwner: z.boolean(),
    withoutDeveloperIntervention: z.boolean(),
  }).strict(),
  steps: stepsSchema,
  observations: z.object({
    installToPairedAsk: timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.installToPairedAsk),
    todayDuringGeneration: z.array(
      timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.generationRead),
    ).length(20),
    sourceDuringGeneration: z.array(
      timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.generationRead),
    ).length(20),
    captures: z.object({
      online: captureSchema,
      "offline-replay": captureSchema,
    }).strict(),
    restart: z.object({
      "mid-operation-reconcile": timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.restartReconcile),
    }).strict(),
    readiness: z.object({
      initial: timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.readiness),
      "after-restart": timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.readiness),
      "after-restore": timedOutcomeSchema(PROTOCOL_TIMEOUT_MS.readiness),
    }).strict(),
    mutationQueue: mutationQueueSchema,
    device: deviceOutcomeSchema,
    recovery: recoveryOutcomeSchema,
    platform: z.object({
      chromium: platformOutcomeSchema,
      ios: platformOutcomeSchema,
    }).strict(),
    cost: z.object({
      model: costSchema,
      transcription: costSchema,
    }).strict(),
  }).strict(),
}).strict().superRefine((packet, context) => {
  for (const platform of ["chromium", "ios"] as const) {
    const anyRan = Object.values(packet.observations.platform[platform])
      .some((outcome) => outcome.outcome !== "not-run");
    const major = platform === "chromium"
      ? packet.environment.chromiumMajor
      : packet.environment.iosMajor;
    if (anyRan && major === null) {
      context.addIssue({
        code: "custom",
        path: ["environment", platform === "chromium" ? "chromiumMajor" : "iosMajor"],
        message: "platform major is required when any platform check ran",
      });
    }
  }
});

export type HomeBetaEvidence = z.infer<typeof homeBetaEvidenceSchema>;

type Rate = Readonly<{ numerator: number; denominator: number }>;
type OutcomeCounts = Readonly<{
  attempted: number;
  success: number;
  timeout: number;
  failed: number;
  "not-run": number;
  successRate: Rate;
}>;
type TimedSummary = OutcomeCounts & Readonly<{
  successfulP95Ms: number | null;
  maxObservedOwnerSuccessfulP95Ms: number | null;
  maxObservedOwnerP95Label: "low-sample-no-population-claim";
}>;

export type HomeBetaValidation = Readonly<{
  schema: typeof HOME_BETA_VALIDATION_SCHEMA;
  status: "valid";
  protocol: typeof HOME_BETA_PROTOCOL;
  productVersion: string;
  target: "darwin-arm64";
  distributionReceiptSha256: string;
  qualified: boolean;
  nonqualificationReasons: ReadonlyArray<HomeBetaNonqualificationReason>;
  manualReview: Readonly<{
    status: "aggregate-only";
    checks: readonly ["owner-truth-consent-and-external-owner", "five-distinct-owners"];
  }>;
}>;

export type HomeBetaReport = Readonly<{
  schema: typeof HOME_BETA_REPORT_SCHEMA;
  status: "ready" | "review-required" | "not-ready";
  protocol: typeof HOME_BETA_PROTOCOL;
  productVersion: string;
  target: "darwin-arm64";
  distributionReceiptSha256: string;
  packets: Readonly<{
    total: number;
    qualified: Rate;
  }>;
  steps: Readonly<Record<typeof HOME_BETA_STEP_KEYS[number], TimedSummary>>;
  measures: Readonly<{
    installToPairedAsk: TimedSummary;
    todayDuringGeneration: TimedSummary;
    sourceDuringGeneration: TimedSummary;
    capture: Readonly<{
      startToLocal: TimedSummary;
      startToCommit: TimedSummary;
      startToAdopt: TimedSummary;
      logicalCases: number;
      lostLogicalCaptures: number;
      duplicateLogicalCaptures: number;
    }>;
    restart: Readonly<{
      midOperationReconcile: TimedSummary;
    }>;
    readiness: Readonly<{
      initial: TimedSummary;
      afterRestart: TimedSummary;
      afterRestore: TimedSummary;
    }>;
    mutationQueue: Readonly<{
      scheduled: number;
      success: number;
      timeout: number;
      failed: number;
      "not-run": number;
      successRate: Rate;
      saturationEvents: number;
      conflictEvents: number;
      retryAttempts: number;
    }>;
    device: Readonly<Record<keyof HomeBetaEvidence["observations"]["device"], TimedSummary>>;
    recovery: Readonly<Record<keyof HomeBetaEvidence["observations"]["recovery"], TimedSummary>>;
    platform: Readonly<{
      chromium: Readonly<Record<keyof HomeBetaEvidence["observations"]["platform"]["chromium"], TimedSummary>>;
      ios: Readonly<Record<keyof HomeBetaEvidence["observations"]["platform"]["ios"], TimedSummary>>;
    }>;
    cost: Readonly<{
      model: CostSummary;
      transcription: CostSummary;
    }>;
  }>;
  nonqualificationReasons: Readonly<Record<HomeBetaNonqualificationReason, number>>;
  blockers: ReadonlyArray<HomeBetaBlocker>;
  manualReview: Readonly<{
    status: "required" | "completed";
    checks: readonly ["owner-truth-consent-and-external-owner", "five-distinct-owners"];
  }>;
}>;

type CostSummary = Readonly<{
  packets: number;
  knownMicroUsd: number;
  known: Rate;
  runLedger: number;
  providerReceipt: number;
  notUsed: number;
  unavailable: number;
}>;

export class HomeBetaEvidenceError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode) {
    super(code);
    this.name = "HomeBetaEvidenceError";
    this.code = code;
  }
}

export function validateHomeBetaEvidence(
  raw: unknown,
  expectedReceiptSha256: string,
  expectedProductVersion: string,
): HomeBetaValidation {
  assertTrustedRelease(expectedReceiptSha256, expectedProductVersion);
  const packet = parsePacket(raw);
  assertExpectedRelease(packet, expectedReceiptSha256, expectedProductVersion);
  const nonqualificationReasons = packetNonqualificationReasons(packet);
  return Object.freeze({
    schema: HOME_BETA_VALIDATION_SCHEMA,
    status: "valid" as const,
    protocol: HOME_BETA_PROTOCOL,
    productVersion: expectedProductVersion,
    target: "darwin-arm64" as const,
    distributionReceiptSha256: expectedReceiptSha256,
    qualified: nonqualificationReasons.length === 0,
    nonqualificationReasons,
    manualReview: Object.freeze({
      status: "aggregate-only" as const,
      checks: Object.freeze([
        "owner-truth-consent-and-external-owner",
        "five-distinct-owners",
      ] as const),
    }),
  });
}

export function aggregateHomeBetaEvidence(
  rawPackets: ReadonlyArray<unknown>,
  expectedReceiptSha256: string,
  expectedProductVersion: string,
  operatorReviewed: boolean,
): HomeBetaReport {
  if (rawPackets.length < MIN_AGGREGATE_PACKETS || rawPackets.length > MAX_AGGREGATE_PACKETS) {
    throw new HomeBetaEvidenceError("input-count");
  }
  assertTrustedRelease(expectedReceiptSha256, expectedProductVersion);
  const packets = rawPackets.map(parsePacket);
  for (const packet of packets) {
    assertExpectedRelease(packet, expectedReceiptSha256, expectedProductVersion);
  }
  const canonical = packets.map((packet) => JSON.stringify(canonicalValue(packet)));
  if (new Set(canonical).size !== canonical.length) {
    throw new HomeBetaEvidenceError("duplicate-packet");
  }

  const perPacketReasons = packets.map(packetNonqualificationReasons);
  const qualified = perPacketReasons.filter((reasons) => reasons.length === 0).length;
  const allQualify = qualified === packets.length;
  const blockers: ReadonlyArray<HomeBetaBlocker> = !allQualify
    ? Object.freeze(["one-or-more-nonqualifying-packets"] as const)
    : !operatorReviewed
      ? Object.freeze(["operator-review-required"] as const)
      : Object.freeze([]);

  const timedGroups = (select: (packet: HomeBetaEvidence) => ReadonlyArray<TimedOutcome>) =>
    packets.map((packet) => select(packet));
  const one = (select: (packet: HomeBetaEvidence) => TimedOutcome) =>
    timedGroups((packet) => [select(packet)]);
  const captureGroups = (key: "start-to-local" | "start-to-commit" | "start-to-adopt") =>
    timedGroups((packet) => [
      packet.observations.captures.online[key],
      packet.observations.captures["offline-replay"][key],
    ]);

  return Object.freeze({
    schema: HOME_BETA_REPORT_SCHEMA,
    status: !allQualify
      ? "not-ready" as const
      : operatorReviewed
        ? "ready" as const
        : "review-required" as const,
    protocol: HOME_BETA_PROTOCOL,
    productVersion: expectedProductVersion,
    target: "darwin-arm64" as const,
    distributionReceiptSha256: expectedReceiptSha256,
    packets: Object.freeze({
      total: packets.length,
      qualified: Object.freeze({ numerator: qualified, denominator: packets.length }),
    }),
    steps: Object.freeze(Object.fromEntries(HOME_BETA_STEP_KEYS.map((key) => [
      key,
      summarizeTimed(one((packet) => packet.steps[key])),
    ])) as Record<typeof HOME_BETA_STEP_KEYS[number], TimedSummary>),
    measures: Object.freeze({
      installToPairedAsk: summarizeTimed(one((packet) => packet.observations.installToPairedAsk)),
      todayDuringGeneration: summarizeTimed(timedGroups((packet) => packet.observations.todayDuringGeneration)),
      sourceDuringGeneration: summarizeTimed(timedGroups((packet) => packet.observations.sourceDuringGeneration)),
      capture: Object.freeze({
        startToLocal: summarizeTimed(captureGroups("start-to-local")),
        startToCommit: summarizeTimed(captureGroups("start-to-commit")),
        startToAdopt: summarizeTimed(captureGroups("start-to-adopt")),
        logicalCases: packets.length * 2,
        lostLogicalCaptures: packets.reduce((total, packet) => total +
          packet.observations.captures.online.lostLogicalCaptures +
          packet.observations.captures["offline-replay"].lostLogicalCaptures, 0),
        duplicateLogicalCaptures: packets.reduce((total, packet) => total +
          packet.observations.captures.online.duplicateLogicalCaptures +
          packet.observations.captures["offline-replay"].duplicateLogicalCaptures, 0),
      }),
      restart: Object.freeze({
        midOperationReconcile: summarizeTimed(one(
          (packet) => packet.observations.restart["mid-operation-reconcile"],
        )),
      }),
      readiness: Object.freeze({
        initial: summarizeTimed(one((packet) => packet.observations.readiness.initial)),
        afterRestart: summarizeTimed(one((packet) => packet.observations.readiness["after-restart"])),
        afterRestore: summarizeTimed(one((packet) => packet.observations.readiness["after-restore"])),
      }),
      mutationQueue: summarizeMutationQueue(packets),
      device: summarizeTimedRecord(packets, DEVICE_OUTCOME_KEYS,
        (packet) => packet.observations.device),
      recovery: summarizeTimedRecord(packets, RECOVERY_OUTCOME_KEYS,
        (packet) => packet.observations.recovery),
      platform: Object.freeze({
        chromium: summarizeTimedRecord(packets, PLATFORM_OUTCOME_KEYS,
          (packet) => packet.observations.platform.chromium),
        ios: summarizeTimedRecord(packets, PLATFORM_OUTCOME_KEYS,
          (packet) => packet.observations.platform.ios),
      }),
      cost: Object.freeze({
        model: summarizeCost(packets.map((packet) => packet.observations.cost.model)),
        transcription: summarizeCost(packets.map((packet) => packet.observations.cost.transcription)),
      }),
    }),
    nonqualificationReasons: Object.freeze(Object.fromEntries(reasonOrder.map((reason) => [
      reason,
      perPacketReasons.filter((reasons) => reasons.includes(reason)).length,
    ])) as Record<HomeBetaNonqualificationReason, number>),
    blockers,
    manualReview: Object.freeze({
      status: operatorReviewed ? "completed" as const : "required" as const,
      checks: Object.freeze([
        "owner-truth-consent-and-external-owner",
        "five-distinct-owners",
      ] as const),
    }),
  });
}

function parsePacket(raw: unknown): HomeBetaEvidence {
  const parsed = homeBetaEvidenceSchema.safeParse(raw);
  if (!parsed.success) throw new HomeBetaEvidenceError("invalid-packet");
  return parsed.data;
}

function assertTrustedRelease(expectedReceipt: string, expectedVersion: string): void {
  if (!sha256.safeParse(expectedReceipt).success) {
    throw new HomeBetaEvidenceError("release-mismatch");
  }
  if (!productVersion.safeParse(expectedVersion).success) {
    throw new HomeBetaEvidenceError("version-mismatch");
  }
}

function assertExpectedRelease(
  packet: HomeBetaEvidence,
  expectedReceipt: string,
  expectedVersion: string,
): void {
  assertTrustedRelease(expectedReceipt, expectedVersion);
  if (packet.product.distributionReceiptSha256 !== expectedReceipt) {
    throw new HomeBetaEvidenceError("release-mismatch");
  }
  if (packet.product.version !== expectedVersion) {
    throw new HomeBetaEvidenceError("version-mismatch");
  }
}

function packetNonqualificationReasons(
  packet: HomeBetaEvidence,
): ReadonlyArray<HomeBetaNonqualificationReason> {
  const reasons = new Set<HomeBetaNonqualificationReason>();
  if (!packet.attestations.consented) reasons.add("consent-not-attested");
  if (!packet.attestations.externalOwner) reasons.add("external-owner-not-attested");
  if (!packet.attestations.withoutDeveloperIntervention) reasons.add("developer-intervention");
  if (HOME_BETA_STEP_KEYS.some((key) => packet.steps[key].outcome !== "ok")) {
    reasons.add("journey-step-not-ok");
  }
  if ([...packet.observations.todayDuringGeneration, ...packet.observations.sourceDuringGeneration]
    .some((outcome) => outcome.outcome !== "ok")) {
    reasons.add("scheduled-observation-not-ok");
  }
  const captures = [packet.observations.captures.online, packet.observations.captures["offline-replay"]];
  if (captures.some((capture) => [capture["start-to-local"], capture["start-to-commit"], capture["start-to-adopt"]]
    .some((outcome) => outcome.outcome !== "ok"))) reasons.add("capture-not-ok");
  if (captures.some((capture) => capture.lostLogicalCaptures > 0)) reasons.add("capture-loss");
  if (captures.some((capture) => capture.duplicateLogicalCaptures > 0)) reasons.add("capture-duplication");
  if (Object.values(packet.observations.restart).some((outcome) => outcome.outcome !== "ok")) {
    reasons.add("restart-reconcile-not-ok");
  }
  if (Object.values(packet.observations.readiness).some((outcome) => outcome.outcome !== "ok") ||
    packet.observations.installToPairedAsk.outcome !== "ok") reasons.add("readiness-not-ok");
  const mutationQueue = packet.observations.mutationQueue;
  if (mutationQueue.scheduled === 0 ||
    mutationQueue.timeout + mutationQueue.failed + mutationQueue.notRun > 0) {
    reasons.add("mutation-queue-not-ok");
  }
  if (Object.values(packet.observations.device).some((outcome) => outcome.outcome !== "ok")) {
    reasons.add("device-outcome-not-ok");
  }
  if (Object.values(packet.observations.recovery).some((outcome) => outcome.outcome !== "ok")) {
    reasons.add("recovery-outcome-not-ok");
  }
  if ([...Object.values(packet.observations.platform.chromium),
    ...Object.values(packet.observations.platform.ios)]
    .some((outcome) => outcome.outcome !== "ok")) {
    reasons.add("platform-outcome-not-ok");
  }
  if (packet.observations.cost.model.source === "not-used" ||
    packet.observations.cost.model.source === "unavailable") {
    reasons.add("model-cost-not-measured");
  }
  if (packet.observations.cost.transcription.source === "unavailable") {
    reasons.add("transcription-cost-unavailable");
  }
  return Object.freeze(reasonOrder.filter((reason) => reasons.has(reason)));
}

function summarizeMutationQueue(packets: ReadonlyArray<HomeBetaEvidence>) {
  const total = (key: keyof HomeBetaEvidence["observations"]["mutationQueue"]) =>
    packets.reduce((sum, packet) => sum + packet.observations.mutationQueue[key], 0);
  const scheduled = total("scheduled");
  const success = total("success");
  return Object.freeze({
    scheduled,
    success,
    timeout: total("timeout"),
    failed: total("failed"),
    "not-run": total("notRun"),
    successRate: Object.freeze({ numerator: success, denominator: scheduled }),
    saturationEvents: total("saturationEvents"),
    conflictEvents: total("conflictEvents"),
    retryAttempts: total("retryAttempts"),
  });
}

function summarizeTimedRecord<Keys extends readonly [string, ...string[]]>(
  packets: ReadonlyArray<HomeBetaEvidence>,
  keys: Keys,
  select: (packet: HomeBetaEvidence) => Readonly<Partial<Record<Keys[number], TimedOutcome>>>,
): Readonly<Record<Keys[number], TimedSummary>> {
  return Object.freeze(Object.fromEntries(keys.map((key: Keys[number]) => [
    key,
    summarizeTimed(packets.map((packet) => [select(packet)[key]!])),
  ])) as Record<Keys[number], TimedSummary>);
}

function summarizeTimed(groups: ReadonlyArray<ReadonlyArray<TimedOutcome>>): TimedSummary {
  const outcomes = groups.flat();
  const successful = outcomes.flatMap((outcome) => outcome.outcome === "ok" ? [outcome.durationMs] : []);
  const ownerP95 = groups.flatMap((group) => {
    const values = group.flatMap((outcome) => outcome.outcome === "ok" ? [outcome.durationMs] : []);
    const value = nearestRankP95(values);
    return value === null ? [] : [value];
  });
  const success = successful.length;
  const timeout = outcomes.filter((outcome) => outcome.outcome === "timeout").length;
  const failed = outcomes.filter((outcome) => outcome.outcome === "failed").length;
  return Object.freeze({
    attempted: success + timeout + failed,
    success,
    timeout,
    failed,
    "not-run": outcomes.filter((outcome) => outcome.outcome === "not-run").length,
    successRate: Object.freeze({ numerator: success, denominator: outcomes.length }),
    successfulP95Ms: nearestRankP95(successful),
    maxObservedOwnerSuccessfulP95Ms: ownerP95.length === 0 ? null : Math.max(...ownerP95),
    maxObservedOwnerP95Label: "low-sample-no-population-claim" as const,
  });
}

function nearestRankP95(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function summarizeCost(costs: ReadonlyArray<z.infer<typeof costSchema>>): CostSummary {
  const known = costs.filter((cost) => cost.microUsd !== null);
  return Object.freeze({
    packets: costs.length,
    knownMicroUsd: known.reduce((total, cost) => total + (cost.microUsd ?? 0), 0),
    known: Object.freeze({ numerator: known.length, denominator: costs.length }),
    runLedger: costs.filter((cost) => cost.source === "run-ledger").length,
    providerReceipt: costs.filter((cost) => cost.source === "provider-receipt").length,
    notUsed: costs.filter((cost) => cost.source === "not-used").length,
    unavailable: costs.filter((cost) => cost.source === "unavailable").length,
  });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

type StableFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

async function readPacket(
  path: string,
  afterOpened: () => Promise<void> = async () => {},
): Promise<unknown> {
  let info;
  try { info = await lstat(path, { bigint: true }); }
  catch { throw new HomeBetaEvidenceError("input-unavailable"); }
  if (!info.isFile() || info.isSymbolicLink()) throw new HomeBetaEvidenceError("input-not-direct");
  if (info.size > BigInt(MAX_PACKET_BYTES)) throw new HomeBetaEvidenceError("input-too-large");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch { throw new HomeBetaEvidenceError("input-unavailable"); }
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile()) throw new HomeBetaEvidenceError("input-not-direct");
    if (!sameStableFile(info, current)) throw new HomeBetaEvidenceError("input-unstable");
    if (current.size > BigInt(MAX_PACKET_BYTES)) throw new HomeBetaEvidenceError("input-too-large");
    await afterOpened();
    const bytes = Buffer.alloc(MAX_PACKET_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = await handle.read(bytes, length, bytes.byteLength - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (!sameStableFile(current, afterRead) || BigInt(length) !== current.size) {
      throw new HomeBetaEvidenceError("input-unstable");
    }
    if (length > MAX_PACKET_BYTES) throw new HomeBetaEvidenceError("input-too-large");
    try { return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown; }
    catch { throw new HomeBetaEvidenceError("invalid-json"); }
  } finally { await handle.close(); }
}

function sameStableFile(left: StableFileStat, right: StableFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function readHomeBetaPacketForTests(
  path: string,
  afterOpened: () => Promise<void>,
): Promise<unknown> {
  return readPacket(path, afterOpened);
}

type CliOptions = Readonly<{
  command: "validate" | "aggregate";
  inputs: ReadonlyArray<string>;
  expectedReceiptSha256: string;
  expectedProductVersion: string;
  operatorReviewed: boolean;
  requireReady: boolean;
}>;

function parseArgs(args: ReadonlyArray<string>): CliOptions {
  const command = args[0];
  if (command !== "validate" && command !== "aggregate") throw new HomeBetaEvidenceError("usage");
  const inputs: string[] = [];
  let expectedReceiptSha256: string | null = null;
  let expectedProductVersion: string | null = null;
  let operatorReviewed = false;
  let requireReady = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new HomeBetaEvidenceError("usage");
      inputs.push(value);
      index += 1;
      continue;
    }
    if (argument === "--expected-receipt") {
      const value = args[index + 1];
      if (expectedReceiptSha256 !== null || value === undefined || !sha256.safeParse(value).success) {
        throw new HomeBetaEvidenceError("usage");
      }
      expectedReceiptSha256 = value;
      index += 1;
      continue;
    }
    if (argument === "--expected-version") {
      const value = args[index + 1];
      if (expectedProductVersion !== null || value === undefined ||
        !productVersion.safeParse(value).success) {
        throw new HomeBetaEvidenceError("usage");
      }
      expectedProductVersion = value;
      index += 1;
      continue;
    }
    if (argument === "--require-ready" && command === "aggregate" && !requireReady) {
      requireReady = true;
      continue;
    }
    if (argument === "--operator-reviewed" && command === "aggregate" && !operatorReviewed) {
      operatorReviewed = true;
      continue;
    }
    throw new HomeBetaEvidenceError("usage");
  }
  if (expectedReceiptSha256 === null || expectedProductVersion === null ||
    (command === "validate" && inputs.length !== 1) ||
    (command === "aggregate" && (inputs.length < MIN_AGGREGATE_PACKETS || inputs.length > MAX_AGGREGATE_PACKETS))) {
    throw new HomeBetaEvidenceError("usage");
  }
  return Object.freeze({
    command,
    inputs: Object.freeze(inputs),
    expectedReceiptSha256,
    expectedProductVersion,
    operatorReviewed,
    requireReady,
  });
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const packets = await Promise.all(options.inputs.map((path) => readPacket(path)));
  if (options.command === "validate") {
    writeJson(validateHomeBetaEvidence(
      packets[0],
      options.expectedReceiptSha256,
      options.expectedProductVersion,
    ));
    return 0;
  }
  const report = aggregateHomeBetaEvidence(
    packets,
    options.expectedReceiptSha256,
    options.expectedProductVersion,
    options.operatorReviewed,
  );
  writeJson(report);
  return options.requireReady && report.status !== "ready" ? 1 : 0;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  main().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error: unknown) => {
      const code = error instanceof HomeBetaEvidenceError ? error.code : "internal-failure";
      writeJson(Object.freeze({ schema: HOME_BETA_COMMAND_SCHEMA, status: "error", error: code }));
      process.exitCode = code === "usage" ? 64 : 1;
    },
  );
}
