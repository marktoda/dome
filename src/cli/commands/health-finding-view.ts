// cli/commands/health-finding-view: shared HealthFinding → finding-primitive
// bridge used by both `dome check` and `dome doctor`. Extracted from
// check.ts (Task 9) so neither command duplicates the subject-override logic.

import type { HealthFinding } from "../../engine/host/health";
import { finding, type Caps, type Finding } from "../presenter";

export const SEVERITY_ORDER: Record<string, number> = {
  block: 0,
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Returns the display subject for a HealthFinding. For the three
 * `capability.grant-*` codes the stored subject is "config" (the key where
 * the grant lives); the more useful display subject is the processor id.
 */
export function subjectFor(hf: HealthFinding): string | undefined {
  if (
    hf.code === "capability.grant-missing" ||
    hf.code === "capability.grant-entry-missing" ||
    hf.code === "capability.grant-starved"
  ) {
    return hf.capability.processorId;
  }
  return hf.subject;
}

/**
 * Render a list of HealthFindings through the `finding` presenter primitive:
 * severity-sorted, blank line between findings, old `[severity] code:` / `recovery:`
 * run-on format replaced with the Rust/Elm anatomy.
 *
 * When `verbose` is false (default): shows the terse `summary` as `what` (if
 * present), else the full `message`. When `verbose` is true: also adds `why`
 * set to the full `message` (only when a `summary` exists — otherwise `what`
 * already is the full message and a redundant `why` would repeat it).
 */
export function findingLines(
  findings: ReadonlyArray<HealthFinding>,
  caps: Caps,
  verbose: boolean = false,
): ReadonlyArray<string> {
  if (findings.length === 0) return [];
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 1) - (SEVERITY_ORDER[b.severity] ?? 1),
  );
  const rendered: string[][] = sorted.map((hf) => {
    const subject = subjectFor(hf);
    const hasSummary =
      (hf.code === "capability.grant-missing" ||
        hf.code === "capability.grant-entry-missing" ||
        hf.code === "capability.grant-starved") &&
      hf.summary !== undefined;
    const what = hasSummary ? (hf as { summary: string }).summary : hf.message;
    const f: Finding = {
      severity: hf.severity,
      code: hf.code,
      ...(subject !== undefined ? { subject } : {}),
      what,
      ...(verbose && hasSummary ? { why: hf.message } : {}),
      fix: hf.recovery,
    };
    return [...finding(f, caps, verbose)];
  });
  const lines: string[] = [];
  for (let i = 0; i < rendered.length; i++) {
    if (i > 0) lines.push("");
    lines.push(...(rendered[i] ?? []));
  }
  return lines;
}
