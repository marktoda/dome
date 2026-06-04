// First-party maintenance-loop metadata.
//
// A maintenance loop is not an executable runtime primitive. Processors remain
// the only executable extension unit; this registry names the desired-state
// objectives those processors maintain so status/check surfaces and tests can
// reason about V1 automations coherently.

export type MaintenanceLoopEvidence =
  | {
      readonly kind: "path";
      readonly pattern: string;
    }
  | {
      readonly kind: "projection";
      readonly name: string;
    }
  | {
      readonly kind: "operational";
      readonly name:
        | "diagnostics"
        | "questions"
        | "runs"
        | "outbox"
        | "quarantines";
    };

export type MaintenanceLoopSurface =
  | {
      readonly kind: "path";
      readonly pattern: string;
    }
  | {
      readonly kind: "command";
      readonly name: string;
    }
  | {
      readonly kind: "projection";
      readonly name: string;
    }
  | {
      readonly kind: "status";
      readonly name: "status" | "check";
    };

export type MaintenanceLoopSettlement = {
  readonly key: string;
  readonly noOpWhen: string;
  readonly checks: ReadonlyArray<MaintenanceLoopSettlementCheck>;
};

export type MaintenanceLoopSettlementCheck = {
  readonly kind:
    | "required-processors-active"
    | "no-attention-diagnostics"
    | "no-drift-diagnostics"
    | "no-open-questions"
    | "no-recent-problem-runs";
  readonly name: string;
  readonly description: string;
};

export type MaintenanceLoop = {
  readonly id: string;
  readonly goal: string;
  readonly evidence: ReadonlyArray<MaintenanceLoopEvidence>;
  /**
   * Required processors for this loop. If some but not all required processors
   * are active, status reports the loop as partial.
   */
  readonly processors: ReadonlyArray<string>;
  /**
   * Optional contributors, usually from opt-in bundles. These processors can
   * add evidence or answers for the same desired state, but their absence does
   * not make the loop partial.
   */
  readonly optionalProcessors?: ReadonlyArray<string>;
  /**
   * Which unresolved QuestionEffect rows should count against this loop's
   * status summary. Most loops use their processor set. The question
   * continuity loop is intentionally cross-cutting and watches all open
   * questions, including questions emitted by processors that primarily belong
   * to another maintenance loop.
   */
  readonly questionScope?: "processors" | "all";
  readonly surfaces: ReadonlyArray<MaintenanceLoopSurface>;
  readonly settlement: MaintenanceLoopSettlement;
  readonly risks: ReadonlyArray<string>;
};

export type MaintenanceLoopValidationError =
  | {
      readonly kind: "invalid-loop-id";
      readonly loopId: string;
    }
  | {
      readonly kind: "duplicate-loop-id";
      readonly loopId: string;
    }
  | {
      readonly kind: "empty-field";
      readonly loopId: string;
      readonly field:
        | "goal"
        | "evidence"
        | "processors"
        | "surfaces"
        | "settlement.key"
        | "settlement.noOpWhen"
        | "settlement.checks"
        | "settlement.check.name"
        | "settlement.check.description"
        | "risks";
    }
  | {
      readonly kind: "duplicate-settlement-check";
      readonly loopId: string;
      readonly checkName: string;
    }
  | {
      readonly kind: "invalid-settlement-check";
      readonly loopId: string;
      readonly checkKind: string;
    }
  | {
      readonly kind: "duplicate-processor";
      readonly loopId: string;
      readonly processorId: string;
    }
  | {
      readonly kind: "missing-processor";
      readonly loopId: string;
      readonly processorId: string;
    }
  | {
      readonly kind: "missing-command-surface";
      readonly loopId: string;
      readonly commandName: string;
    }
  | {
      readonly kind: "invalid-projection";
      readonly loopId: string;
      readonly projectionName: string;
    }
  | {
      readonly kind: "invalid-status-surface";
      readonly loopId: string;
      readonly statusName: string;
    }
  | {
      readonly kind: "invalid-path-pattern";
      readonly loopId: string;
      readonly pattern: string;
    };

const LOOP_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

const SUPPORTED_PROJECTION_NAMES = Object.freeze([
  "diagnostics",
  "facts",
  "fts_documents",
  "questions",
  "scheduled_jobs",
]);

const FACT_NAMESPACE_PROJECTION_RE = /^facts:[a-z0-9]+(?:[.-][a-z0-9]+)*\.\*$/;

const SUPPORTED_STATUS_SURFACES = new Set(["status", "check"]);

const SUPPORTED_SETTLEMENT_CHECKS = new Set<
  MaintenanceLoopSettlementCheck["kind"]
>([
  "required-processors-active",
  "no-attention-diagnostics",
  "no-drift-diagnostics",
  "no-open-questions",
  "no-recent-problem-runs",
]);

const STANDARD_SETTLEMENT_CHECKS = Object.freeze([
  freezeSettlementCheck({
    kind: "required-processors-active",
    name: "required-processors-active",
    description: "Every required processor for this loop is active.",
  }),
  freezeSettlementCheck({
    kind: "no-attention-diagnostics",
    name: "no-attention-diagnostics",
    description:
      "No source-backed warning/error/block diagnostics are attributed to this loop.",
  }),
  freezeSettlementCheck({
    kind: "no-drift-diagnostics",
    name: "no-drift-diagnostics",
    description:
      "No remaining info-level content drift diagnostics are attributed to this loop.",
  }),
  freezeSettlementCheck({
    kind: "no-open-questions",
    name: "no-open-questions",
    description:
      "No unresolved questions in this loop's question scope need an answer.",
  }),
  freezeSettlementCheck({
    kind: "no-recent-problem-runs",
    name: "no-recent-problem-runs",
    description:
      "No recent required or optional processor runs are in a terminal problem state.",
  }),
] satisfies ReadonlyArray<MaintenanceLoopSettlementCheck>);

export const FIRST_PARTY_MAINTENANCE_LOOPS: ReadonlyArray<MaintenanceLoop> =
  Object.freeze([
    freezeLoop({
      id: "dome.capture.digest",
      goal: "New raw captures have a source-backed disposition.",
      evidence: [
        { kind: "path", pattern: ".dome/config.yaml" },
        { kind: "path", pattern: ".dome/model-provider.ts" },
        { kind: "path", pattern: "inbox/raw/*.md" },
        { kind: "path", pattern: "inbox/processed/*.md" },
        { kind: "path", pattern: "wiki/generated/intake/*.md" },
        { kind: "projection", name: "facts:dome.intake.*" },
        { kind: "operational", name: "questions" },
      ],
      processors: [
        "dome.intake.extract-capture",
        "dome.intake.capture-index",
        "dome.intake.inbox-stale-check",
        "dome.intake.low-confidence-answer",
        "dome.intake.synthesize-capture",
        "dome.intake.synthesize-rollup",
      ],
      surfaces: [
        { kind: "path", pattern: "wiki/generated/intake/*.md" },
        { kind: "path", pattern: "wiki/syntheses/intake-*.md" },
        { kind: "command", name: "query" },
        { kind: "command", name: "export-context" },
      ],
      settlement: {
        key: "raw path + raw content hash + processor version",
        noOpWhen:
          "the current raw capture hash has a matching generated digest, processed archive, disposition, extractor schema, and rebuildable pending-question state",
        checks: STANDARD_SETTLEMENT_CHECKS,
      },
      risks: [
        "LLM extraction can still produce noisy summaries even when source-hash identity is stable.",
        "Low-confidence findings should remain questions instead of becoming silent claims.",
      ],
    }),
    freezeLoop({
      id: "dome.open-loop.continuity",
      goal:
        "Important unresolved work remains visible until resolved, dismissed, or superseded.",
      evidence: [
        { kind: "path", pattern: "wiki/**/*.md" },
        { kind: "path", pattern: "notes/*.md" },
        { kind: "projection", name: "facts:dome.daily.*" },
        { kind: "operational", name: "questions" },
      ],
      processors: [
        "dome.daily.create-daily",
        "dome.daily.task-index",
        "dome.daily.stamp-block-id",
        "dome.daily.reconcile-tasks",
        "dome.daily.normalize-task-syntax",
        "dome.daily.ambiguous-followup-answer",
        "dome.daily.today",
        "dome.daily.prep",
        "dome.daily.agenda-with",
        "dome.daily.carry-forward",
      ],
      surfaces: [
        { kind: "path", pattern: "wiki/dailies/*.md" },
        { kind: "path", pattern: "notes/*.md" },
        { kind: "command", name: "query" },
        { kind: "command", name: "export-context" },
      ],
      settlement: {
        key: "source ref + normalized open-loop text + optional project/entity",
        noOpWhen:
          "the open loop is represented once from its source and the generated daily surface block matches the current source set",
        checks: STANDARD_SETTLEMENT_CHECKS,
      },
      risks: [
        "Repeated daily surfacing can duplicate tasks if generated daily blocks are treated as source facts.",
        "Daily-note edits must stay collaborative markdown, not a rigid generated database.",
      ],
    }),
    freezeLoop({
      id: "dome.link-concept.coherence",
      goal:
        "Links and concepts are navigable, intentionally unresolved, or preserved as uncertainty.",
      evidence: [
        { kind: "path", pattern: "**/*.md" },
        { kind: "projection", name: "facts:dome.graph.*" },
        { kind: "operational", name: "diagnostics" },
        { kind: "operational", name: "questions" },
      ],
      processors: [
        "dome.markdown.validate-wikilinks",
        "dome.markdown.ambiguous-wikilink-answer",
        "dome.markdown.repair-wikilinks",
        "dome.markdown.simplify-indexes",
        "dome.markdown.normalize-frontmatter",
        "dome.markdown.lint-frontmatter",
        "dome.markdown.broken-images",
        "dome.markdown.duplicate-detection",
        "dome.markdown.duplicate-detection-answer",
        "dome.markdown.stale-dates",
        "dome.markdown.refresh-updated",
        "dome.markdown.raw-immutable",
        "dome.markdown.orphan-pages",
        "dome.graph.links",
        "dome.graph.tag-index",
      ],
      surfaces: [
        { kind: "path", pattern: "**/*.md" },
        { kind: "projection", name: "diagnostics" },
        { kind: "status", name: "check" },
      ],
      settlement: {
        key: "link occurrence, duplicate page-pair, or metadata path plus content hash",
        noOpWhen:
          "the link resolves, is intentionally unresolved, has exactly one open question, or the managed metadata already matches git history",
        checks: STANDARD_SETTLEMENT_CHECKS,
      },
      risks: [
        "Ambiguous broken links can create duplicate stub pages if confidence is not enforced.",
        "Duplicate consolidation must preserve source material before deletion.",
      ],
    }),
    freezeLoop({
      id: "dome.context.packet",
      goal:
        "Active work has concise source-backed context packets for foreground agents.",
      evidence: [
        { kind: "path", pattern: "**/*.md" },
        { kind: "projection", name: "fts_documents" },
        { kind: "projection", name: "facts" },
        { kind: "operational", name: "questions" },
      ],
      processors: [
        "dome.search.index-text",
        "dome.search.query",
        "dome.search.export-context",
      ],
      optionalProcessors: [
        "dome.warden.daily-briefing",
      ],
      surfaces: [
        { kind: "command", name: "query" },
        { kind: "command", name: "export-context" },
      ],
      settlement: {
        key: "packet target + adopted source set + processor version",
        noOpWhen:
          "the packet or query result was produced from the same relevant source set",
        checks: STANDARD_SETTLEMENT_CHECKS,
      },
      risks: [
        "Packets that over-read become noisy and reduce foreground-agent precision.",
        "Persisted packets must not rewrite markdown unless their source set changes.",
      ],
    }),
    freezeLoop({
      id: "dome.question.continuity",
      goal:
        "Important uncertainty remains alive until answered, obsoleted, or dismissed.",
      evidence: [
        { kind: "operational", name: "questions" },
        { kind: "operational", name: "diagnostics" },
        { kind: "path", pattern: "**/*.md" },
      ],
      processors: [
        "dome.health.outbox-recovery-questions",
        "dome.health.outbox-recovery-answer",
        "dome.health.quarantine-recovery-questions",
        "dome.health.quarantine-recovery-answer",
        "dome.health.orphan-run-recovery-questions",
        "dome.health.orphan-run-recovery-answer",
        "dome.markdown.ambiguous-wikilink-answer",
        "dome.markdown.duplicate-detection-answer",
        "dome.daily.ambiguous-followup-answer",
      ],
      optionalProcessors: [
        "dome.intake.low-confidence-answer",
        "dome.warden.integrity",
        "dome.warden.integrity-answer",
      ],
      questionScope: "all",
      surfaces: [
        { kind: "status", name: "status" },
        { kind: "status", name: "check" },
        { kind: "command", name: "query" },
        { kind: "command", name: "export-context" },
      ],
      settlement: {
        key: "question idempotency key + source refs",
        noOpWhen:
          "each uncertainty is answered, obsoleted, or represented exactly once as unresolved",
        checks: STANDARD_SETTLEMENT_CHECKS,
      },
      risks: [
        "Open questions can become user chores if safe agent-resolution metadata is missing.",
        "Answer handlers must keep routing patches through garden and adoption.",
      ],
    }),
  ]);

export function validateMaintenanceLoops(opts: {
  readonly loops: ReadonlyArray<MaintenanceLoop>;
  readonly processorIds: ReadonlySet<string>;
  readonly commandNames: ReadonlySet<string>;
}): ReadonlyArray<MaintenanceLoopValidationError> {
  const errors: MaintenanceLoopValidationError[] = [];
  const seen = new Set<string>();
  for (const loop of opts.loops) {
    if (!LOOP_ID_RE.test(loop.id)) {
      errors.push({ kind: "invalid-loop-id", loopId: loop.id });
    }
    if (seen.has(loop.id)) {
      errors.push({ kind: "duplicate-loop-id", loopId: loop.id });
    }
    seen.add(loop.id);
    if (loop.goal.trim().length === 0) {
      errors.push({ kind: "empty-field", loopId: loop.id, field: "goal" });
    }
    if (loop.evidence.length === 0) {
      errors.push({ kind: "empty-field", loopId: loop.id, field: "evidence" });
    }
    if (loop.processors.length === 0) {
      errors.push({
        kind: "empty-field",
        loopId: loop.id,
        field: "processors",
      });
    }
    if (loop.surfaces.length === 0) {
      errors.push({ kind: "empty-field", loopId: loop.id, field: "surfaces" });
    }
    if (loop.settlement.key.trim().length === 0) {
      errors.push({
        kind: "empty-field",
        loopId: loop.id,
        field: "settlement.key",
      });
    }
    if (loop.settlement.noOpWhen.trim().length === 0) {
      errors.push({
        kind: "empty-field",
        loopId: loop.id,
        field: "settlement.noOpWhen",
      });
    }
    if (loop.settlement.checks.length === 0) {
      errors.push({
        kind: "empty-field",
        loopId: loop.id,
        field: "settlement.checks",
      });
    }
    const seenSettlementChecks = new Set<string>();
    for (const check of loop.settlement.checks) {
      if (!SUPPORTED_SETTLEMENT_CHECKS.has(check.kind)) {
        errors.push({
          kind: "invalid-settlement-check",
          loopId: loop.id,
          checkKind: check.kind,
        });
      }
      if (check.name.trim().length === 0) {
        errors.push({
          kind: "empty-field",
          loopId: loop.id,
          field: "settlement.check.name",
        });
      }
      if (check.description.trim().length === 0) {
        errors.push({
          kind: "empty-field",
          loopId: loop.id,
          field: "settlement.check.description",
        });
      }
      if (seenSettlementChecks.has(check.name)) {
        errors.push({
          kind: "duplicate-settlement-check",
          loopId: loop.id,
          checkName: check.name,
        });
      }
      seenSettlementChecks.add(check.name);
    }
    if (loop.risks.length === 0) {
      errors.push({ kind: "empty-field", loopId: loop.id, field: "risks" });
    }
    const processorReferences = [
      ...loop.processors,
      ...(loop.optionalProcessors ?? Object.freeze([])),
    ];
    const seenProcessorReferences = new Set<string>();
    for (const processorId of processorReferences) {
      if (seenProcessorReferences.has(processorId)) {
        errors.push({
          kind: "duplicate-processor",
          loopId: loop.id,
          processorId,
        });
      }
      seenProcessorReferences.add(processorId);
    }
    for (const evidence of loop.evidence) {
      if (evidence.kind === "path" && !isValidVaultPattern(evidence.pattern)) {
        errors.push({
          kind: "invalid-path-pattern",
          loopId: loop.id,
          pattern: evidence.pattern,
        });
      }
      if (
        evidence.kind === "projection" &&
        !isSupportedProjectionName(evidence.name)
      ) {
        errors.push({
          kind: "invalid-projection",
          loopId: loop.id,
          projectionName: evidence.name,
        });
      }
    }
    for (const processorId of processorReferences) {
      if (!opts.processorIds.has(processorId)) {
        errors.push({
          kind: "missing-processor",
          loopId: loop.id,
          processorId,
        });
      }
    }
    for (const surface of loop.surfaces) {
      if (surface.kind === "path" && !isValidVaultPattern(surface.pattern)) {
        errors.push({
          kind: "invalid-path-pattern",
          loopId: loop.id,
          pattern: surface.pattern,
        });
      }
      if (surface.kind === "command" && !opts.commandNames.has(surface.name)) {
        errors.push({
          kind: "missing-command-surface",
          loopId: loop.id,
          commandName: surface.name,
        });
      }
      if (
        surface.kind === "projection" &&
        !isSupportedProjectionName(surface.name)
      ) {
        errors.push({
          kind: "invalid-projection",
          loopId: loop.id,
          projectionName: surface.name,
        });
      }
      if (
        surface.kind === "status" &&
        !SUPPORTED_STATUS_SURFACES.has(surface.name)
      ) {
        errors.push({
          kind: "invalid-status-surface",
          loopId: loop.id,
          statusName: surface.name,
        });
      }
    }
  }
  return Object.freeze(errors);
}

function freezeLoop(loop: MaintenanceLoop): MaintenanceLoop {
  return Object.freeze({
    ...loop,
    evidence: Object.freeze(loop.evidence.map((item) => Object.freeze(item))),
    processors: Object.freeze([...loop.processors]),
    ...(loop.optionalProcessors !== undefined
      ? { optionalProcessors: Object.freeze([...loop.optionalProcessors]) }
      : {}),
    surfaces: Object.freeze(loop.surfaces.map((item) => Object.freeze(item))),
    settlement: Object.freeze({
      ...loop.settlement,
      checks: Object.freeze(
        loop.settlement.checks.map((check) => freezeSettlementCheck(check)),
      ),
    }),
    risks: Object.freeze([...loop.risks]),
  });
}

function freezeSettlementCheck(
  check: MaintenanceLoopSettlementCheck,
): MaintenanceLoopSettlementCheck {
  return Object.freeze({ ...check });
}

function isValidVaultPattern(pattern: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern.startsWith("/") || pattern.includes("\\")) return false;
  return !pattern.split("/").includes("..");
}

function isSupportedProjectionName(name: string): boolean {
  return SUPPORTED_PROJECTION_NAMES.includes(name) ||
    FACT_NAMESPACE_PROJECTION_RE.test(name);
}
