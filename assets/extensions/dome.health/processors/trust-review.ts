// dome.health.trust-review — the trust ladder (product review 5, Task 4).
// Cron `24 5 * * 1` (Monday 05:24, after the 05:22 report card whose trust
// section shows the same evidence, before the 05:30 brief).
//
// Deterministic garden processor: NO model. The gardener proposes changes to
// its OWN autonomy through the existing proposal review loop:
//   - PROMOTE: a producer whose grant is propose-only, with ≥8 decided
//     proposals over the trailing 28 days at ≥0.75 accept rate, gets ONE
//     propose-mode PatchEffect carrying a comment-preserving
//     `.dome/config.yaml` diff that grants it `patch.auto` for the paths it
//     currently proposes. The owner reviews with `dome apply` — the engine
//     never auto-applies its own autonomy change (the patch is mode:
//     "propose" AND this processor's grant is patch.propose-only on the
//     config path, a structural double fence).
//   - FLAG DORMANT: a processor with model spend > $0 and zero productive
//     effects over the trailing 21 days raises ONE owner-needed question.
//     Per-processor disable is NOT expressible in `.dome/config.yaml`
//     (extensions.<bundle>.processors.<id> accepts only grant/grants —
//     src/engine/core/capability-policy.ts PROCESSOR_KEYS), so this stays a
//     question, not a config proposal.
//
// Idempotence: an open promotion proposal for the same target suppresses
// re-emission; a rejected promotion is not re-proposed for 28 days (derived
// from the rejected row's decidedAt — no new state); the pending-proposals
// dedupe key covers byte-identical re-emission; dormancy questions carry a
// per-processor idempotency key.
//
// NEEDS_ARE_LOUD: a missing proposals view skips promotions with a warning; a
// missing runs view skips dormancy with a warning; an unreadable/unparseable
// config skips promotions with a warning (compose-blocks posture).
//
// Normative: [[wiki/specs/proposals]] §"Trust ladder".

import {
  diagnosticEffect,
  patchEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { parseScheduleInput } from "../../dome.daily/processors/daily-paths";

import {
  aggregateProposalActivity,
  aggregateRunActivity,
  CONFIG_PATH,
  decideTrustReview,
  DORMANT_WINDOW_DAYS,
  grantedAutonomy,
  policyFromConfigBody,
  PROMOTE_MIN_DECIDED,
  promoteProcessorGrantInConfig,
  promotionSuppression,
  TRUST_WINDOW_DAYS,
  type TrustProposalStats,
  type TrustRunStats,
} from "./trust-review-shared";

const DAY_MS = 24 * 60 * 60 * 1000;

const trustReview = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // Weekly cron only; the scheduled fire time drives the windows (the
    // report-card pattern — re-runs against the same fire stay deterministic).
    const firedAt = parseScheduleInput(ctx.input)?.firedAt ?? null;
    const now = firedAt === null ? ctx.now() : new Date(firedAt);
    const nowIso = now.toISOString();
    const proposalWindowStartIso = new Date(
      now.getTime() - TRUST_WINDOW_DAYS * DAY_MS,
    ).toISOString();
    const dormantWindowStartIso = new Date(
      now.getTime() - DORMANT_WINDOW_DAYS * DAY_MS,
    ).toISOString();

    const effects: Effect[] = [];
    const warn = (code: string, message: string): void => {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code,
          message,
          sourceRefs: [ctx.sourceRef(CONFIG_PATH)],
        }),
      );
    };

    // ----- Promotion evidence: proposal rows + the vault grant surface -------
    let proposalStats: ReadonlyArray<TrustProposalStats> = Object.freeze([]);
    let configBody: string | null = null;
    const proposalsView = ctx.operational?.proposals;
    if (proposalsView === undefined) {
      // Declared proposals.read with no view is LOUD, never a silent skip
      // (NEEDS_ARE_LOUD; the compose-blocks posture).
      warn(
        "dome.health.trust-review-proposals-view-missing",
        "dome.health.trust-review declares proposals.read but received no proposals view; trust promotions are skipped",
      );
    } else {
      const rows = proposalsView();
      const activity = aggregateProposalActivity(rows, proposalWindowStartIso);
      // The config read is a need only once some producer clears the decided
      // volume bar — a quiet vault (fresh init, no proposal traffic) must not
      // collect a weekly config nag for a promotion pass that has nothing to
      // evaluate. Past the bar, an unreadable config IS loud (NEEDS_ARE_LOUD):
      // trust review genuinely cannot classify autonomy there.
      let policy: ReturnType<typeof policyFromConfigBody> = null;
      const hasPromotionVolume = activity.some(
        (row) => row.decided >= PROMOTE_MIN_DECIDED,
      );
      if (hasPromotionVolume) {
        configBody = await ctx.snapshot.readFile(CONFIG_PATH);
        policy = configBody === null ? null : policyFromConfigBody(configBody);
        if (policy === null) {
          warn(
            "dome.health.trust-review-config-unreadable",
            configBody === null
              ? "dome.health.trust-review could not read .dome/config.yaml from the snapshot; trust promotions are skipped"
              : "dome.health.trust-review could not parse .dome/config.yaml; trust promotions are skipped",
          );
          // `grantedAutonomy` resolves to "unknown" without a policy, so the
          // decide core refuses every promotion — evidence still aggregates.
        }
      }
      proposalStats = Object.freeze(
        activity.map(
          (activity) => {
            const suppression = promotionSuppression(rows, activity.processorId);
            return Object.freeze({
              ...activity,
              autonomy: grantedAutonomy({
                policy,
                extensionId: activity.extensionId,
                processorId: activity.processorId,
                paths: activity.proposedPaths,
              }),
              pendingPromotion: suppression.pending,
              promotionRejectedAt: suppression.rejectedAt,
            });
          },
        ),
      );
    }

    // ----- Dormancy evidence: run rows over the trailing 21 days -------------
    let runStats: ReadonlyArray<TrustRunStats> = Object.freeze([]);
    const runsView = ctx.operational?.runs;
    if (runsView === undefined) {
      warn(
        "dome.health.trust-review-runs-view-missing",
        "dome.health.trust-review declares run.read but received no run view; the dormancy check is skipped",
      );
    } else {
      runStats = aggregateRunActivity(
        runsView({ startedSince: dormantWindowStartIso }),
      );
    }

    // ----- Decide + emit ------------------------------------------------------
    for (const decision of decideTrustReview({ nowIso, proposalStats, runStats })) {
      if (decision.kind === "promote") {
        if (configBody === null) continue; // already LOUD above
        const edited = promoteProcessorGrantInConfig({
          configBody,
          extensionId: decision.extensionId,
          processorId: decision.processorId,
          autoPaths: decision.autoPaths,
        });
        if (!edited.ok) {
          warn(
            "dome.health.trust-review-promotion-edit-failed",
            `dome.health.trust-review could not build the promotion config diff for ${decision.processorId}: ${edited.error}`,
          );
          continue;
        }
        effects.push(
          patchEffect({
            mode: "propose",
            changes: [
              { kind: "write", path: CONFIG_PATH, content: edited.content },
            ],
            reason: decision.evidence,
            sourceRefs: [ctx.sourceRef(CONFIG_PATH)],
          }),
        );
      } else {
        effects.push(
          questionEffect({
            question:
              `${decision.evidence} (no succeeded run emitted an effect). ` +
              "Per-processor disable is not expressible in .dome/config.yaml — " +
              "keep it running, or disable/narrow its bundle by hand " +
              "(extensions.<bundle>.enabled / grant)?",
            options: ["keep", "will-disable-by-hand"],
            idempotencyKey: `dome.health.trust-review:dormant:${decision.processorId}`,
            metadata: {
              automationPolicy: "owner-needed",
              recommendedAnswer: "keep",
              ownerNeededReason:
                "disabling a processor is a config decision only the owner can make",
            },
            sourceRefs: [ctx.sourceRef(CONFIG_PATH)],
          }),
        );
      }
    }
    return Object.freeze([...effects]);
  },
});

export default trustReview;
