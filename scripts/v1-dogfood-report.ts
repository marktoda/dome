#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type ReportOptions = {
  readonly ledger: string;
  readonly today: string;
  readonly minDays: number;
  readonly minCaptureDays: number;
  readonly minSpanDays: number;
  readonly json: boolean;
  readonly requireReady: boolean;
};

type Dimension = {
  readonly id: string;
  readonly label: string;
  readonly patterns: ReadonlyArray<RegExp>;
};

type SafetyCheck = {
  readonly id: string;
  readonly label: string;
  readonly patterns: ReadonlyArray<RegExp>;
};

type DayReport = {
  readonly date: string;
  readonly dateStatus: "valid" | "future" | "invalid";
  readonly headings: ReadonlyArray<string>;
  readonly complete: boolean;
  readonly operationalEvidence: boolean;
  readonly serveHostEvidence: boolean;
  readonly captureEvidence: boolean;
  readonly safetyConfirmed: boolean;
  readonly presentDimensions: ReadonlyArray<string>;
  readonly missingDimensions: ReadonlyArray<string>;
  readonly missingSafetyConfirmations: ReadonlyArray<string>;
  readonly releaseBlockers: ReadonlyArray<string>;
};

type DogfoodReport = {
  readonly ledger: string;
  readonly required: {
    readonly completeWorkdays: number;
    readonly serveHostEvidenceDays: number;
    readonly captureEvidenceDays: number;
    readonly spanCalendarDays: number;
  };
  readonly status: "ready" | "not-ready";
  readonly completeWorkdays: number;
  readonly serveHostEvidenceDays: number;
  readonly captureEvidenceDays: number;
  readonly spanCalendarDays: number;
  readonly releaseBlockers: ReadonlyArray<{
    readonly date: string;
    readonly blockers: ReadonlyArray<string>;
  }>;
  readonly readiness: ReadonlyArray<ReadinessCriterion>;
  readonly dimensions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly days: number;
  }>;
  readonly days: ReadonlyArray<DayReport>;
};

type ReadinessCriterion = {
  readonly id:
    | "complete_workdays"
    | "serve_host_evidence_days"
    | "capture_evidence_days"
    | "span_calendar_days"
    | "release_blockers";
  readonly label: string;
  readonly current: number;
  readonly required: number;
  readonly remaining: number;
  readonly ready: boolean;
};

const repoRoot = resolve(import.meta.dir, "..");
const defaultLedger = resolve(
  repoRoot,
  "docs/cohesive/reviews/2026-06-02-v1-work-vault-dogfood-ledger.md",
);

const dimensions: readonly Dimension[] = Object.freeze([
  {
    id: "daily_note_usefulness",
    label: "Daily note usefulness",
    patterns: [/^daily note usefulness$/i],
  },
  {
    id: "capture_digestion",
    label: "Capture digestion",
    patterns: [/^capture digestion$/i],
  },
  {
    id: "open_loop_surfacing",
    label: "Open-loop surfacing",
    patterns: [/^open[- ]loop surfacing$/i],
  },
  {
    id: "context_packet_quality",
    label: "Context packet quality",
    patterns: [/^context packet quality$/i],
  },
  {
    id: "question_burden",
    label: "Question burden",
    patterns: [/^question burden$/i],
  },
  {
    id: "link_concept_hygiene",
    label: "Link/concept hygiene",
    patterns: [/^link\/concept hygiene$/i, /^link and concept hygiene$/i],
  },
  {
    id: "friction",
    label: "Friction / manual foreground-agent work Dome should own",
    patterns: [
      /^friction$/i,
      /^friction\s*\/\s*manual foreground-agent work dome should own$/i,
      /^manual foreground-agent work dome should own$/i,
    ],
  },
]);

const safetyChecks: readonly SafetyCheck[] = Object.freeze([
  {
    id: "lost_or_overwritten_edits",
    label: "Lost or overwritten human markdown edits",
    patterns: [/^lost or overwritten human markdown edits$/i],
  },
  {
    id: "manual_dome_state_edits",
    label: "Manual .dome/state edits",
    patterns: [/^manual \.dome\/state edits$/i],
  },
]);

const captureEvidencePathPatterns: readonly RegExp[] = Object.freeze([
  /\binbox\/processed\/[^\s`),]+/,
  /\bwiki\/generated\/intake\/[^\s`),]+/,
]);

const positiveCaptureEvidencePatterns: readonly RegExp[] = Object.freeze([
  /\b(processed|digested|archived|generated|created|produced|extracted|converted)\b.{0,80}\b(raw capture|capture|captures|processed archive|generated intake|intake page)\b/i,
  /\b(raw capture|capture|captures|processed archive|generated intake|intake page)\b.{0,80}\b(processed|digested|archived|generated|created|produced|extracted|converted)\b/i,
]);

const negativeCaptureEvidencePatterns: readonly RegExp[] = Object.freeze([
  /\b(no|none|zero|without)\b.{0,80}\b(raw captures?|captures?|capture digestion|processed captures?|processed archive|generated intake|intake pages?)\b/i,
  /\b(did not|didn't|not)\b.{0,80}\b(process|digest|archive|generate|create|produce|extract|convert)\b.{0,80}\b(raw captures?|captures?|processed archive|generated intake|intake pages?)\b/i,
]);

const placeholderDimensionValuePatterns: readonly RegExp[] = Object.freeze([
  /^(?:todo|to do|tbd|to be determined|placeholder|pending|unknown|unsure|not sure|n\/a|na|\?+)$/i,
  /^(?:not filled|not filled yet|fill in|fill me|fill this|fill later|fill after(?: the)? session)$/i,
  /^[._-]+$/,
]);

const contradictorySafetyQualifierPatterns: readonly RegExp[] = Object.freeze([
  /\b(but|except|other than|aside from|however|although|though)\b/i,
]);

const operationalEvidenceLinePatterns: readonly RegExp[] = Object.freeze([
  /`bun run v1:dogfood-snapshot(?:\s|`)/,
  /`bin\/dome (check|query|export-context)\b/,
  /^(?:[-*]\s*)?(?:ran\s+)?bun run v1:dogfood-snapshot\b/i,
  /^(?:[-*]\s*)?(?:ran\s+)?bin\/dome (check|query|export-context)\b/i,
]);

const negativeOperationalEvidencePatterns: readonly RegExp[] = Object.freeze([
  /\b(no|not|without|did not|didn't)\b.{0,80}\b(bun run v1:dogfood-snapshot|bin\/dome (check|query|export-context))\b/i,
  /\b(bun run v1:dogfood-snapshot|bin\/dome (check|query|export-context))\b.{0,80}\b(not run|not used|missing|absent|unavailable|failed to run)\b/i,
]);

const serveHostEvidenceLinePatterns: readonly RegExp[] = Object.freeze([
  /^(?:[-*]\s*)?Serve host:\s*running(?:[;.,\s]|$)/i,
  /^(?:[-*]\s*)?`?["']?serve_status["']?`?:\s*["']?running["']?(?:[;,\s}]|$)/i,
  /`Serve host:\s*running(?:[;.,\s]|`)/i,
  /`serve_status:\s*running`/i,
]);

const contradictoryServeHostPatterns: readonly RegExp[] = Object.freeze([
  /\b(but|except|however|although|though)\b/i,
  /\b(off|stale|stopped|not running|wrong branch|different branch|no running host)\b/i,
]);

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const markdown = await readFile(opts.ledger, "utf8");
  const report = buildReport(markdown, opts);
  nodeWrite(
    opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report),
  );
  if (opts.requireReady && report.status !== "ready") {
    process.exit(1);
  }
}

function buildReport(markdown: string, opts: ReportOptions): DogfoodReport {
  const todayDay = calendarDay(opts.today);
  if (todayDay === null) {
    throw new Error(`--today must be a valid YYYY-MM-DD date`);
  }
  const days = parseDaySections(markdown).map((day) =>
    analyzeDay(day, todayDay)
  );
  const completeWorkdays = days.filter((day) => day.complete).length;
  const serveHostEvidenceDays = days.filter((day) =>
    day.complete && day.serveHostEvidence
  ).length;
  const captureEvidenceDays = days.filter((day) =>
    day.complete && day.captureEvidence
  ).length;
  const spanCalendarDays = completeWorkdaySpanDays(days);
  const releaseBlockers = days
    .filter((day) => day.releaseBlockers.length > 0)
    .map((day) => ({ date: day.date, blockers: day.releaseBlockers }));
  const readiness = buildReadiness({
    completeWorkdays,
    serveHostEvidenceDays,
    captureEvidenceDays,
    spanCalendarDays,
    releaseBlockers: releaseBlockers.length,
    required: {
      completeWorkdays: opts.minDays,
      serveHostEvidenceDays: opts.minDays,
      captureEvidenceDays: opts.minCaptureDays,
      spanCalendarDays: opts.minSpanDays,
    },
  });
  const status = readiness.every((criterion) => criterion.ready)
    ? "ready"
    : "not-ready";

  return {
    ledger: opts.ledger,
    required: {
      completeWorkdays: opts.minDays,
      serveHostEvidenceDays: opts.minDays,
      captureEvidenceDays: opts.minCaptureDays,
      spanCalendarDays: opts.minSpanDays,
    },
    status,
    completeWorkdays,
    serveHostEvidenceDays,
    captureEvidenceDays,
    spanCalendarDays,
    releaseBlockers,
    readiness,
    dimensions: dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      days: days.filter((day) =>
        day.dateStatus === "valid" &&
        day.presentDimensions.includes(dimension.id)
      ).length,
    })),
    days,
  };
}

function buildReadiness(input: {
  readonly completeWorkdays: number;
  readonly serveHostEvidenceDays: number;
  readonly captureEvidenceDays: number;
  readonly spanCalendarDays: number;
  readonly releaseBlockers: number;
  readonly required: {
    readonly completeWorkdays: number;
    readonly serveHostEvidenceDays: number;
    readonly captureEvidenceDays: number;
    readonly spanCalendarDays: number;
  };
}): ReadonlyArray<ReadinessCriterion> {
  return Object.freeze([
    thresholdCriterion({
      id: "complete_workdays",
      label: "Complete workdays",
      current: input.completeWorkdays,
      required: input.required.completeWorkdays,
    }),
    thresholdCriterion({
      id: "serve_host_evidence_days",
      label: "Serve-host evidence days",
      current: input.serveHostEvidenceDays,
      required: input.required.serveHostEvidenceDays,
    }),
    thresholdCriterion({
      id: "capture_evidence_days",
      label: "Complete capture-evidence days",
      current: input.captureEvidenceDays,
      required: input.required.captureEvidenceDays,
    }),
    thresholdCriterion({
      id: "span_calendar_days",
      label: "Complete-workday span",
      current: input.spanCalendarDays,
      required: input.required.spanCalendarDays,
    }),
    blockerCriterion(input.releaseBlockers),
  ]);
}

function thresholdCriterion(input: {
  readonly id: ReadinessCriterion["id"];
  readonly label: string;
  readonly current: number;
  readonly required: number;
}): ReadinessCriterion {
  const remaining = Math.max(0, input.required - input.current);
  return Object.freeze({
    id: input.id,
    label: input.label,
    current: input.current,
    required: input.required,
    remaining,
    ready: remaining === 0,
  });
}

function blockerCriterion(current: number): ReadinessCriterion {
  return Object.freeze({
    id: "release_blockers",
    label: "Release blockers",
    current,
    required: 0,
    remaining: current,
    ready: current === 0,
  });
}

function completeWorkdaySpanDays(days: ReadonlyArray<DayReport>): number {
  const completeDates = days
    .filter((day) => day.complete)
    .map((day) => daysSinceEpoch(day.date));
  if (completeDates.length === 0) return 0;
  return Math.max(...completeDates) - Math.min(...completeDates) + 1;
}

function parseDaySections(markdown: string): Array<{
  readonly date: string;
  readonly headings: string[];
  readonly text: string;
}> {
  const sections: Array<{
    readonly date: string;
    readonly heading: string;
    readonly text: string;
  }> = [];
  const lines = markdown.split(/\r?\n/);
  let current:
    | {
        date: string;
        heading: string;
        lines: string[];
      }
    | undefined;

  for (const line of lines) {
    const match = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?\s*$/.exec(line);
    if (match !== null) {
      if (current !== undefined) {
        sections.push({
          date: current.date,
          heading: current.heading,
          text: current.lines.join("\n"),
        });
      }
      current = {
        date: match[1],
        heading: match[2]?.trim() ?? "",
        lines: [line],
      };
      continue;
    }
    current?.lines.push(line);
  }

  if (current !== undefined) {
    sections.push({
      date: current.date,
      heading: current.heading,
      text: current.lines.join("\n"),
    });
  }

  const byDate = new Map<string, { headings: string[]; parts: string[] }>();
  for (const section of sections) {
    const existing = byDate.get(section.date) ?? { headings: [], parts: [] };
    if (section.heading !== "") existing.headings.push(section.heading);
    existing.parts.push(section.text);
    byDate.set(section.date, existing);
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, grouped]) => ({
      date,
      headings: grouped.headings,
      text: grouped.parts.join("\n\n"),
    }));
}

function analyzeDay(day: {
  readonly date: string;
  readonly headings: ReadonlyArray<string>;
  readonly text: string;
}, todayDay: number): DayReport {
  const dayNumber = calendarDay(day.date);
  const dateStatus = dayNumber === null
    ? "invalid"
    : dayNumber > todayDay
    ? "future"
    : "valid";
  const presentDimensions = dimensions
    .filter((dimension) => hasFilledDimension(day.text, dimension))
    .map((dimension) => dimension.id);
  const missingDimensions = dimensions
    .filter((dimension) => !presentDimensions.includes(dimension.id))
    .map((dimension) => dimension.id);
  const operationalEvidence = hasOperationalEvidence(day.text);
  const serveHostEvidence = hasServeHostEvidence(day.text);
  const safety = analyzeSafety(day.text);

  return {
    date: day.date,
    dateStatus,
    headings: day.headings,
    complete:
      dateStatus === "valid" &&
      missingDimensions.length === 0 &&
      operationalEvidence &&
      serveHostEvidence &&
      safety.missing.length === 0 &&
      safety.blockers.length === 0,
    operationalEvidence,
    serveHostEvidence,
    captureEvidence:
      presentDimensions.includes("capture_digestion") &&
      hasCaptureEvidence(day.text),
    safetyConfirmed: safety.missing.length === 0 && safety.blockers.length === 0,
    presentDimensions,
    missingDimensions,
    missingSafetyConfirmations: safety.missing,
    releaseBlockers: safety.blockers,
  };
}

function hasFilledDimension(text: string, dimension: Dimension): boolean {
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    const match = /^(?:[-*]\s*)?([^:]{1,100}):\s*(.*)$/.exec(normalized);
    if (match === null) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (!isFilledDimensionValue(value)) continue;
    for (const pattern of dimension.patterns) {
      if (pattern.test(label)) return true;
    }
  }
  return false;
}

function isFilledDimensionValue(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized === "") return false;
  return !placeholderDimensionValuePatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

function analyzeSafety(text: string): {
  readonly missing: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<string>;
} {
  const answers = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    const match = /^(?:[-*]\s*)?([^:]{1,100}):\s*(.*)$/.exec(normalized);
    if (match === null) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    for (const check of safetyChecks) {
      if (check.patterns.some((pattern) => pattern.test(label))) {
        const existing = answers.get(check.id) ?? [];
        existing.push(value);
        answers.set(check.id, existing);
      }
    }
  }

  const missing: string[] = [];
  const blockers: string[] = [];
  for (const check of safetyChecks) {
    const filledAnswers = (answers.get(check.id) ?? []).filter((answer) =>
      isFilledSafetyConfirmationValue(answer)
    );
    if (filledAnswers.length === 0) {
      missing.push(check.id);
      continue;
    }
    if (filledAnswers.some((answer) => !isNegativeConfirmation(answer))) {
      blockers.push(check.id);
    }
  }
  return { missing, blockers };
}

function isFilledSafetyConfirmationValue(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized === "") return false;
  return !placeholderDimensionValuePatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

function isNegativeConfirmation(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!/^(no|none|not observed|not seen)([.;,\s]|$)/.test(normalized)) {
    return false;
  }
  return !contradictorySafetyQualifierPatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

function hasOperationalEvidence(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const clauses = line.split(/;|\.\s+/);
    return clauses.some(hasOperationalEvidenceClause);
  });
}

function hasOperationalEvidenceClause(clause: string): boolean {
  const normalized = clause.trim();
  if (normalized === "") return false;
  if (
    negativeOperationalEvidencePatterns.some((pattern) =>
      pattern.test(normalized)
    )
  ) {
    return false;
  }
  return operationalEvidenceLinePatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

function hasServeHostEvidence(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const normalized = line.trim();
    if (normalized === "") return false;
    if (
      !serveHostEvidenceLinePatterns.some((pattern) => pattern.test(normalized))
    ) {
      return false;
    }
    return !contradictoryServeHostPatterns.some((pattern) =>
      pattern.test(normalized)
    );
  });
}

function hasCaptureEvidence(text: string): boolean {
  return text.split(/\r?\n/).some((line) => hasCaptureEvidenceLine(line));
}

function hasCaptureEvidenceLine(line: string): boolean {
  const normalized = line.trim();
  if (normalized === "") return false;

  if (isNegativeCaptureEvidenceLine(normalized)) return false;

  if (captureEvidencePathPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return positiveCaptureEvidencePatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

function isNegativeCaptureEvidenceLine(line: string): boolean {
  return negativeCaptureEvidencePatterns.some((pattern) => pattern.test(line));
}

function renderReport(report: DogfoodReport): string {
  const lines: string[] = [];
  lines.push("# V1 M10 Dogfood Report");
  lines.push("");
  lines.push(`Ledger: \`${report.ledger}\``);
  lines.push(`Status: ${report.status}`);
  lines.push(
    `Complete workdays: ${report.completeWorkdays}/` +
      `${report.required.completeWorkdays}`,
  );
  lines.push(
    `Serve-host evidence days: ${report.serveHostEvidenceDays}/` +
      `${report.required.serveHostEvidenceDays}`,
  );
  lines.push(
    `Complete capture-evidence days: ${report.captureEvidenceDays}/` +
      `${report.required.captureEvidenceDays}`,
  );
  lines.push(
    `Complete-workday span: ${report.spanCalendarDays}/` +
      `${report.required.spanCalendarDays} calendar day(s)`,
  );
  lines.push(`Release blockers: ${report.releaseBlockers.length}`);
  lines.push("");
  lines.push("Release readiness:");
  const incomplete = report.readiness.filter((criterion) => !criterion.ready);
  if (incomplete.length === 0) {
    lines.push("- All criteria satisfied.");
  } else {
    for (const criterion of incomplete) {
      lines.push(`- ${formatReadinessCriterion(criterion)}`);
    }
  }
  lines.push("");
  lines.push("Rubric coverage:");
  for (const dimension of report.dimensions) {
    lines.push(`- ${dimension.label}: ${dimension.days} day(s)`);
  }
  lines.push("");
  lines.push("Days:");
  if (report.days.length === 0) {
    lines.push("- No dated dogfood entries found.");
  } else {
    for (const day of report.days) {
      const state = day.complete ? "complete" : "partial";
      const missing = day.missingDimensions.length === 0
        ? ""
        : `; missing ${day.missingDimensions.join(", ")}`;
      const missingSafety = day.missingSafetyConfirmations.length === 0
        ? ""
        : `; missing safety ${day.missingSafetyConfirmations.join(", ")}`;
      const blockers = day.releaseBlockers.length === 0
        ? ""
        : `; blockers ${day.releaseBlockers.join(", ")}`;
      const evidence = [
        ...(day.dateStatus === "valid" ? [] : [`${day.dateStatus} date`]),
        day.operationalEvidence
          ? "operational evidence"
          : "no operational evidence",
        day.serveHostEvidence
          ? "serve-host evidence"
          : "no serve-host evidence",
        day.captureEvidence ? "capture evidence" : "no capture evidence",
        day.safetyConfirmed ? "safety confirmed" : "safety unconfirmed",
      ].join("; ");
      lines.push(
        `- ${day.date}: ${state}; ${evidence}${missing}` +
          `${missingSafety}${blockers}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "M10 is ready only when enough real work-vault days have complete rubric " +
      "notes, running serve-host evidence, a two-real-work-week span, and " +
      "enough complete days exercise the capture loop with no release blockers.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatReadinessCriterion(criterion: ReadinessCriterion): string {
  if (criterion.id === "release_blockers") {
    return `${criterion.label}: resolve ${criterion.remaining} blocker(s)`;
  }
  if (criterion.id === "span_calendar_days") {
    return (
      `${criterion.label}: need ${criterion.remaining} more calendar day(s) ` +
      `(${criterion.current}/${criterion.required})`
    );
  }
  return (
    `${criterion.label}: need ${criterion.remaining} more ` +
    `(${criterion.current}/${criterion.required})`
  );
}

function parseArgs(args: ReadonlyArray<string>): ReportOptions {
  let ledger = defaultLedger;
  let today = localDateString();
  let minDays = 10;
  let minCaptureDays = 5;
  let minSpanDays = 12;
  let json = false;
  let requireReady = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ledger") {
      ledger = resolve(readValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--today") {
      today = readValue(args, i, arg);
      if (calendarDay(today) === null) {
        throw new Error("--today must be a valid YYYY-MM-DD date");
      }
      i += 1;
      continue;
    }
    if (arg === "--min-days") {
      minDays = parsePositiveInteger(readValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === "--min-capture-days") {
      minCaptureDays = parsePositiveInteger(readValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === "--min-span-days") {
      minSpanDays = parsePositiveInteger(readValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--require-ready") {
      requireReady = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return Object.freeze({
    ledger,
    today,
    minDays,
    minCaptureDays,
    minSpanDays,
    json,
    requireReady,
  });
}

function readValue(
  args: ReadonlyArray<string>,
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function daysSinceEpoch(date: string): number {
  const day = calendarDay(date);
  if (day === null) {
    throw new Error(`invalid calendar date: ${date}`);
  }
  return day;
}

function calendarDay(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utc.getTime() / 86_400_000);
}

function localDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function printHelp(): void {
  nodeWrite([
    "Usage: bun scripts/v1-dogfood-report.ts [options]",
    "",
    "Audits the M10 work-vault dogfood ledger against the V1 release-soak rubric.",
    "",
    "Options:",
    "  --ledger <path>            Ledger Markdown path.",
    "  --today <YYYY-MM-DD>       Last date eligible to count (default: today).",
    "  --min-days <n>             Complete workday threshold (default: 10).",
    "  --min-capture-days <n>     Capture-evidence threshold (default: 5).",
    "  --min-span-days <n>        Complete-workday calendar span (default: 12).",
    "  --json                     Emit machine-readable JSON.",
    "  --require-ready            Exit nonzero unless the report is ready.",
    "  -h, --help                 Show this help.",
    "",
  ].join("\n"));
}

function nodeWrite(text: string): void {
  process.stdout.write(text);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`v1-dogfood-report: ${message}`);
  process.exit(1);
});
