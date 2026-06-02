#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type ReportOptions = {
  readonly ledger: string;
  readonly minDays: number;
  readonly minCaptureDays: number;
  readonly json: boolean;
};

type Dimension = {
  readonly id: string;
  readonly label: string;
  readonly patterns: ReadonlyArray<RegExp>;
};

type DayReport = {
  readonly date: string;
  readonly headings: ReadonlyArray<string>;
  readonly complete: boolean;
  readonly operationalEvidence: boolean;
  readonly captureEvidence: boolean;
  readonly presentDimensions: ReadonlyArray<string>;
  readonly missingDimensions: ReadonlyArray<string>;
};

type DogfoodReport = {
  readonly ledger: string;
  readonly required: {
    readonly completeWorkdays: number;
    readonly captureEvidenceDays: number;
  };
  readonly status: "ready" | "not-ready";
  readonly completeWorkdays: number;
  readonly captureEvidenceDays: number;
  readonly dimensions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly days: number;
  }>;
  readonly days: ReadonlyArray<DayReport>;
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

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const markdown = await readFile(opts.ledger, "utf8");
  const report = buildReport(markdown, opts);
  nodeWrite(
    opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report),
  );
}

function buildReport(markdown: string, opts: ReportOptions): DogfoodReport {
  const days = parseDaySections(markdown).map((day) => analyzeDay(day));
  const completeWorkdays = days.filter((day) => day.complete).length;
  const captureEvidenceDays = days.filter((day) => day.captureEvidence).length;
  const status =
    completeWorkdays >= opts.minDays &&
    captureEvidenceDays >= opts.minCaptureDays
      ? "ready"
      : "not-ready";

  return {
    ledger: opts.ledger,
    required: {
      completeWorkdays: opts.minDays,
      captureEvidenceDays: opts.minCaptureDays,
    },
    status,
    completeWorkdays,
    captureEvidenceDays,
    dimensions: dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      days: days.filter((day) => day.presentDimensions.includes(dimension.id))
        .length,
    })),
    days,
  };
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
}): DayReport {
  const presentDimensions = dimensions
    .filter((dimension) => hasFilledDimension(day.text, dimension))
    .map((dimension) => dimension.id);
  const missingDimensions = dimensions
    .filter((dimension) => !presentDimensions.includes(dimension.id))
    .map((dimension) => dimension.id);
  const operationalEvidence = hasOperationalEvidence(day.text);

  return {
    date: day.date,
    headings: day.headings,
    complete: missingDimensions.length === 0 && operationalEvidence,
    operationalEvidence,
    captureEvidence:
      presentDimensions.includes("capture_digestion") &&
      hasCaptureEvidence(day.text),
    presentDimensions,
    missingDimensions,
  };
}

function hasFilledDimension(text: string, dimension: Dimension): boolean {
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    const match = /^(?:[-*]\s*)?([^:]{1,100}):\s*(.*)$/.exec(normalized);
    if (match === null) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (value.length === 0) continue;
    for (const pattern of dimension.patterns) {
      if (pattern.test(label)) return true;
    }
  }
  return false;
}

function hasOperationalEvidence(text: string): boolean {
  return (
    /\bbun run v1:dogfood-snapshot\b/.test(text) ||
    /\bbin\/dome (status|check|today|query|export-context)\b/.test(text) ||
    /^Operational state:/m.test(text)
  );
}

function hasCaptureEvidence(text: string): boolean {
  return (
    /\binbox\/raw\b/.test(text) ||
    /\binbox\/processed\b/.test(text) ||
    /\bwiki\/generated\/intake\b/.test(text) ||
    /\braw capture\b/i.test(text) ||
    /\bprocessed capture\b/i.test(text) ||
    /\bprocessed archive\b/i.test(text) ||
    /\bgenerated intake\b/i.test(text)
  );
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
    `Capture-evidence days: ${report.captureEvidenceDays}/` +
      `${report.required.captureEvidenceDays}`,
  );
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
      const evidence = [
        day.operationalEvidence
          ? "operational evidence"
          : "no operational evidence",
        day.captureEvidence ? "capture evidence" : "no capture evidence",
      ].join("; ");
      lines.push(`- ${day.date}: ${state}; ${evidence}${missing}`);
    }
  }
  lines.push("");
  lines.push(
    "M10 is ready only when enough real work-vault days have complete rubric " +
      "notes and the capture loop has been exercised across a real work week.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseArgs(args: ReadonlyArray<string>): ReportOptions {
  let ledger = defaultLedger;
  let minDays = 10;
  let minCaptureDays = 5;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ledger") {
      ledger = resolve(readValue(args, i, arg));
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
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return Object.freeze({ ledger, minDays, minCaptureDays, json });
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

function printHelp(): void {
  nodeWrite([
    "Usage: bun scripts/v1-dogfood-report.ts [options]",
    "",
    "Audits the M10 work-vault dogfood ledger against the V1 release-soak rubric.",
    "",
    "Options:",
    "  --ledger <path>            Ledger Markdown path.",
    "  --min-days <n>             Complete workday threshold (default: 10).",
    "  --min-capture-days <n>     Capture-evidence threshold (default: 5).",
    "  --json                     Emit machine-readable JSON.",
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
