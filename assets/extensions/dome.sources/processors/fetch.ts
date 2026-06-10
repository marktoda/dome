// dome.sources.fetch — subscription scheduler for committed external feeds.
//
// Reads `extensions.dome.sources.config.subscriptions` (the consent surface)
// and, for each enabled subscription whose cron has fired today and whose
// rendered output file is absent from the adopted snapshot, emits one
// ExternalActionEffect with idempotency key `dome.sources:<kind>:<date>`.
// The handler side (`external-handlers/sources.fetch.ts`) runs the
// subscription's vault-configured fetch command, which writes + commits the
// `sources/<kind>/<date>.md` file as an ordinary non-engine commit the
// daemon adopts.
//
// Deliberately STATELESS — no cursor, no facts: due-ness derives from
// (cron, firedAt), fetch-once from the outbox idempotency-key UNIQUE
// constraint, done-ness from snapshot file presence. Re-emitting the same
// (kind, date) key every 15-minute tick is the designed retry pump (INSERT
// OR IGNORE + backoff-paced dispatch). Normative contract:
// [[wiki/specs/sources]].
//
// Config temperament (consolidate's): malformed config degrades to skipping
// the malformed entry with one info diagnostic (`dome.sources.invalid-config`),
// never a thrown run. Disabled or absent subscriptions emit nothing, silently.

import {
  diagnosticEffect,
  externalActionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { nextFire, parseCron } from "../../../../src/engine/cron";

const CONFIG_PATH = ".dome/config.yaml";
const KIND_RE = /^[a-z0-9][a-z0-9._-]*$/;

type ScheduleInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};

export type SourceSubscription = {
  readonly kind: string;
  readonly schedule: string;
  readonly outputPathTemplate: string;
  readonly command: ReadonlyArray<string>;
};

export type SubscriptionsResolution = {
  readonly subscriptions: ReadonlyArray<SourceSubscription>;
  /**
   * Human-readable problems for malformed config that was skipped. The
   * processor surfaces each as one info diagnostic. Disabled / absent
   * subscriptions are NOT problems — they contribute nothing here.
   */
  readonly problems: ReadonlyArray<string>;
};

/**
 * Parse `extensions.dome.sources.config.subscriptions` with the
 * fallback-not-crash temperament: each malformed piece is skipped with a
 * recorded problem; well-formed enabled siblings still run. A subscription
 * runs only when `enabled` is EXACTLY `true` — consent is explicit.
 */
export function resolveSubscriptions(
  config?: Readonly<Record<string, unknown>>,
): SubscriptionsResolution {
  const raw = config?.subscriptions;
  if (raw === undefined) return resolution([], []);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return resolution(
      [],
      ["subscriptions must be a mapping of <kind> to subscription settings"],
    );
  }

  const subscriptions: SourceSubscription[] = [];
  const problems: string[] = [];
  for (const [kind, entry] of Object.entries(raw)) {
    if (!KIND_RE.test(kind)) {
      problems.push(
        `subscription kind "${kind}" must match ${KIND_RE.source}`,
      );
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`subscription "${kind}" must be a mapping`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.enabled !== true) {
      // Absent or false → silently inert; non-boolean junk is still silent
      // (it is not consent, and disabled is a state, not a problem).
      continue;
    }

    const schedule = record.schedule;
    if (typeof schedule !== "string" || schedule.trim().length === 0) {
      problems.push(
        `subscription "${kind}" schedule must be a 5-field cron string`,
      );
      continue;
    }
    try {
      parseCron(schedule);
    } catch (e) {
      problems.push(
        `subscription "${kind}" schedule is not a valid cron expression: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }

    const outputPath = record.output_path;
    const outputProblem =
      typeof outputPath === "string"
        ? outputPathTemplateProblem(outputPath)
        : "output_path must be a string";
    if (outputProblem !== null) {
      problems.push(`subscription "${kind}" ${outputProblem}`);
      continue;
    }

    const command = record.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      problems.push(
        `subscription "${kind}" command must be a non-empty list of strings`,
      );
      continue;
    }

    subscriptions.push(
      Object.freeze({
        kind,
        schedule,
        outputPathTemplate: outputPath as string,
        command: Object.freeze([...(command as string[])]),
      }),
    );
  }
  return resolution(subscriptions, problems);
}

/**
 * `output_path` must be a relative vault `.md` path with a `{date}`
 * placeholder (the period key — without it the rendered path is constant
 * and skip-if-present would permanently retire the subscription after one
 * fetch). Returns the problem string, or null when well-formed.
 */
export function outputPathTemplateProblem(template: string): string | null {
  if (template.trim() !== template || template.length === 0) {
    return "output_path must be a non-empty path without surrounding whitespace";
  }
  if (!template.includes("{date}")) {
    return "output_path must contain a {date} placeholder";
  }
  if (!template.endsWith(".md")) {
    return "output_path must end with .md";
  }
  if (template.startsWith("/") || template.includes("\\")) {
    return "output_path must be a relative vault path";
  }
  const segments = template.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return "output_path must not contain empty, '.' or '..' segments";
  }
  return null;
}

/**
 * A subscription is due when its cron's FIRST fire of firedAt's local day
 * is <= firedAt. No backfill by design: a cron that fires later today is
 * not yet due; one that does not fire today at all (weekly schedules on an
 * off day) is not due; a host returning from a long sleep fetches today's
 * period, never yesterday's. Throws never — an impossible cron (rejected
 * by nextFire's iteration cap) reports as not-due via the caller's
 * parseCron problem path or the null return here.
 */
export function isDueToday(schedule: string, firedAt: Date): boolean {
  let parsed;
  try {
    parsed = parseCron(schedule);
  } catch {
    return false;
  }
  const midnight = new Date(firedAt.getTime());
  midnight.setHours(0, 0, 0, 0);
  let first: Date;
  try {
    // nextFire returns the first match strictly after `after`; starting one
    // minute before local midnight makes midnight itself eligible.
    first = nextFire(parsed, new Date(midnight.getTime() - 60_000));
  } catch {
    return false;
  }
  return first.getTime() <= firedAt.getTime();
}

/** Vault-local YYYY-MM-DD of the fire — the subscription period key. */
export function localDateOf(at: Date): string {
  const yyyy = String(at.getFullYear()).padStart(4, "0");
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function renderOutputPath(template: string, date: string): string {
  return template.replaceAll("{date}", date);
}

export function fetchIdempotencyKey(kind: string, date: string): string {
  return `dome.sources:${kind}:${date}`;
}

const fetch = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseScheduleInput(ctx.input);
    if (input === null) return [];
    const firedAt = new Date(input.firedAt);

    const { subscriptions, problems } = resolveSubscriptions(
      ctx.extensionConfig,
    );

    const effects: Effect[] = problems.map((problem) =>
      diagnosticEffect({
        severity: "info",
        code: "dome.sources.invalid-config",
        message: `dome.sources config ${problem}; the subscription is skipped until the config is fixed`,
        sourceRefs: [ctx.sourceRef(CONFIG_PATH)],
      }),
    );

    const date = localDateOf(firedAt);
    for (const subscription of subscriptions) {
      if (!isDueToday(subscription.schedule, firedAt)) continue;
      const outputPath = renderOutputPath(
        subscription.outputPathTemplate,
        date,
      );
      // Skip-if-present: a prior fetch landed, or the human wrote the file
      // by hand — either way the period is satisfied and we emit nothing.
      const existing = await ctx.snapshot.readFile(outputPath);
      if (existing !== null) continue;

      effects.push(
        externalActionEffect({
          capability: "sources.fetch",
          idempotencyKey: fetchIdempotencyKey(subscription.kind, date),
          payload: {
            kind: subscription.kind,
            date,
            output_path: outputPath,
            command: [...subscription.command],
          },
          sourceRefs: [ctx.sourceRef(CONFIG_PATH)],
        }),
      );
    }

    return Object.freeze(effects);
  },
});

export default fetch;

function resolution(
  subscriptions: ReadonlyArray<SourceSubscription>,
  problems: ReadonlyArray<string>,
): SubscriptionsResolution {
  return Object.freeze({
    subscriptions: Object.freeze([...subscriptions]),
    problems: Object.freeze([...problems]),
  });
}

function parseScheduleInput(input: unknown): ScheduleInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (record.kind !== "schedule") return null;
  if (typeof record.cron !== "string") return null;
  if (typeof record.firedAt !== "string") return null;
  if (Number.isNaN(new Date(record.firedAt).getTime())) return null;
  return Object.freeze({
    kind: "schedule",
    cron: record.cron,
    firedAt: new Date(record.firedAt).toISOString(),
  });
}
