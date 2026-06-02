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
  readonly surfaces: ReadonlyArray<MaintenanceLoopSurface>;
  readonly settlement: MaintenanceLoopSettlement;
  readonly risks: ReadonlyArray<string>;
};

export type MaintenanceLoopValidationError =
  | {
      readonly kind: "duplicate-loop-id";
      readonly loopId: string;
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
      readonly kind: "invalid-path-pattern";
      readonly loopId: string;
      readonly pattern: string;
    };

export const FIRST_PARTY_MAINTENANCE_LOOPS: ReadonlyArray<MaintenanceLoop> =
  Object.freeze([
    freezeLoop({
      id: "dome.capture.digest",
      goal: "New raw captures have a source-backed disposition.",
      evidence: [
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
          "the current raw capture hash has a matching generated digest, processed archive, disposition, and rebuildable pending-question state",
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
        "dome.daily.ambiguous-followup-answer",
        "dome.daily.today",
        "dome.daily.prep",
        "dome.daily.agenda-with",
        "dome.daily.carry-forward",
      ],
      surfaces: [
        { kind: "path", pattern: "wiki/dailies/*.md" },
        { kind: "path", pattern: "notes/*.md" },
        { kind: "command", name: "today" },
        { kind: "command", name: "prep" },
        { kind: "command", name: "agenda-with" },
        { kind: "command", name: "export-context" },
      ],
      settlement: {
        key: "source ref + normalized open-loop text + optional project/entity",
        noOpWhen:
          "the open loop is represented once from its source and the generated daily surface block matches the current source set",
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
        "dome.markdown.normalize-frontmatter",
        "dome.markdown.lint-frontmatter",
        "dome.markdown.broken-images",
        "dome.markdown.duplicate-detection",
        "dome.markdown.stale-dates",
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
        key: "link occurrence or duplicate page-pair plus content hash",
        noOpWhen:
          "the link resolves, is intentionally unresolved, or has exactly one open question",
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
      surfaces: [
        { kind: "command", name: "query" },
        { kind: "command", name: "export-context" },
      ],
      settlement: {
        key: "packet target + adopted source set + processor version",
        noOpWhen:
          "the packet or query result was produced from the same relevant source set",
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
        "dome.daily.ambiguous-followup-answer",
      ],
      optionalProcessors: [
        "dome.intake.low-confidence-answer",
      ],
      surfaces: [
        { kind: "status", name: "status" },
        { kind: "status", name: "check" },
        { kind: "command", name: "today" },
        { kind: "command", name: "prep" },
      ],
      settlement: {
        key: "question idempotency key + source refs",
        noOpWhen:
          "each uncertainty is answered, obsoleted, or represented exactly once as unresolved",
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
    if (seen.has(loop.id)) {
      errors.push({ kind: "duplicate-loop-id", loopId: loop.id });
    }
    seen.add(loop.id);
    const processorReferences = [
      ...loop.processors,
      ...(loop.optionalProcessors ?? Object.freeze([])),
    ];
    for (const evidence of loop.evidence) {
      if (evidence.kind === "path" && !isValidVaultPattern(evidence.pattern)) {
        errors.push({
          kind: "invalid-path-pattern",
          loopId: loop.id,
          pattern: evidence.pattern,
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
    settlement: Object.freeze({ ...loop.settlement }),
    risks: Object.freeze([...loop.risks]),
  });
}

function isValidVaultPattern(pattern: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern.startsWith("/") || pattern.includes("\\")) return false;
  return !pattern.split("/").includes("..");
}
