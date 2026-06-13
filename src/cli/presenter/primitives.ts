import type { Caps } from "./caps";
import { bold, glyph, paint, severityTone, statusGlyph, type Severity, type Tone } from "./theme";
import { pad, truncate, visibleWidth, wrap } from "./width";

export type Status = { readonly tone: Tone; readonly label: string };

export function statusValue(status: Status, caps: Caps): string {
  const g = statusGlyph(status.tone, caps);
  return `${g} ${paint(status.label, status.tone, caps)}`;
}

export function headline(
  left: { readonly cmd: string; readonly context?: string },
  status: Status,
  caps: Caps,
): string {
  const sep = glyph("sep", caps);
  const leftPlain =
    left.context !== undefined ? `dome ${left.cmd} ${sep} ${left.context}` : `dome ${left.cmd}`;
  // Color: dim "dome", bold cmd. Keep plain text for width math.
  const leftStyled = caps.color
    ? leftPlain.replace(`dome ${left.cmd}`, `${paint("dome", "muted", caps)} ${bold(left.cmd, caps)}`)
    : leftPlain;
  const right = statusValue(status, caps);
  const rightPlain = `${statusGlyph(status.tone, caps)} ${status.label}`;
  const gap = caps.width - visibleWidth(leftPlain) - visibleWidth(rightPlain);
  const spacer = gap >= 1 ? " ".repeat(gap) : "  ";
  return `${leftStyled}${spacer}${right}`;
}

export function section(
  title: string,
  body: ReadonlyArray<string>,
  caps: Caps,
): ReadonlyArray<string> {
  if (body.length === 0) return [];
  // Body lines arrive already carrying the primitives' 2-space indent; section
  // adds 2 more so the ALLCAPS title sits at indent 2 and body at indent 4.
  // Titles are bold + cyan ("ident" tone) so the section structure stands out;
  // cyan is non-status, so it doesn't collide with green/red/yellow semantics.
  const heading = bold(paint(title.toUpperCase(), "ident", caps), caps);
  return ["", `  ${heading}`, ...body.map((l) => `  ${l}`)];
}

export type KvRow = { readonly label: string; readonly value: string; readonly tone?: Tone };

export function kv(rows: ReadonlyArray<KvRow>, caps: Caps): ReadonlyArray<string> {
  const labelWidth = rows.reduce((m, r) => Math.max(m, visibleWidth(r.label)), 0);
  return rows.map((r) => {
    const label = paint(pad(r.label, labelWidth), "muted", caps);
    const value = paint(r.value, r.tone ?? "plain", caps);
    return `  ${label}   ${value}`;
  });
}

export function rule(caps: Caps, label?: string): string {
  const ch = caps.unicode ? "─" : "-";
  const line = ch.repeat(Math.max(0, caps.width));
  const text =
    label === undefined
      ? line
      : `${ch}${ch} ${label} ${ch.repeat(Math.max(0, caps.width - label.length - 4))}`;
  return paint(text, "muted", caps);
}

export function footer(status: Status, caps: Caps): ReadonlyArray<string> {
  return ["", rule(caps), statusValue(status, caps)];
}

export function bullets(
  items: ReadonlyArray<string>,
  caps: Caps,
  empty = "none",
): ReadonlyArray<string> {
  if (items.length === 0) return [`  ${paint(empty, "muted", caps)}`];
  return items.map((it) => `  - ${it}`);
}

export type NextAction = { readonly command: string | null; readonly description: string };

export function nextActions(
  actions: ReadonlyArray<NextAction>,
  caps: Caps,
): ReadonlyArray<string> {
  return actions.map((a) => {
    const cmd = paint(a.command ?? "manual", "ident", caps);
    return `  ${glyph("pointer", caps)} ${cmd}   ${a.description}`;
  });
}

export type TreeNode = { readonly label: string; readonly lines: ReadonlyArray<string> };

export function tree(nodes: ReadonlyArray<TreeNode>, caps: Caps): ReadonlyArray<string> {
  const tee = caps.unicode ? "├─" : "|-";
  const elbow = caps.unicode ? "└─" : "`-";
  const out: string[] = [];
  nodes.forEach((node, i) => {
    const connector = i === nodes.length - 1 ? elbow : tee;
    out.push(`  ${connector} ${node.label}`);
    for (const line of node.lines) out.push(`       ${line}`);
  });
  return out;
}

/**
 * Join count terms with the `·` separator, painting any term whose count is
 * zero in the muted tone so the eye skips it. Terms are never removed or
 * reordered — layout stays stable. A term is "zero" when it starts with `0`
 * not followed by another digit (so `0`, `0 failed` dim; `10 known` does not).
 */
export function dimZeros(terms: ReadonlyArray<string>, caps: Caps): string {
  return terms
    .map((t) => (/^0(?!\d)/.test(t) ? paint(t, "muted", caps) : t))
    .join(" · ");
}

export type Finding = {
  readonly severity: Severity;
  readonly code: string;
  readonly subject?: string;
  readonly what: string;
  readonly note?: string;
  readonly fix?: string;
};

const FINDING_INDENT = "      "; // 6 spaces — content column
const FINDING_LABEL_WIDTH = 4; // "note", "fix " padded equal

function findingLabeledLines(label: string, text: string, caps: Caps): string[] {
  const labelCell = paint(pad(label, FINDING_LABEL_WIDTH), "muted", caps);
  const textIndent = " ".repeat(FINDING_INDENT.length + FINDING_LABEL_WIDTH + 3);
  const avail = Math.max(8, caps.width - textIndent.length);
  const [first, ...rest] = wrap(text, avail);
  const out = [`${FINDING_INDENT}${labelCell}   ${first ?? ""}`];
  for (const line of rest) out.push(`${textIndent}${line}`);
  return out;
}

/**
 * Render one diagnostic finding in the Rust/Elm anatomy: a severity-glyph +
 * code (+ optional subject) header, a plain-language `what` line, then an
 * optional dim `note` (why it matters) and `fix` (suggestion), each on its
 * own line. The full original message lives in `--json`.
 */
export function finding(f: Finding, caps: Caps): ReadonlyArray<string> {
  const tone = severityTone(f.severity);
  const g = paint(statusGlyph(tone, caps), tone, caps);
  const code = paint(f.code, tone, caps);
  const header =
    f.subject !== undefined
      ? `  ${g} ${code} ${glyph("sep", caps)} ${paint(f.subject, "muted", caps)}`
      : `  ${g} ${code}`;
  const out: string[] = [header];
  const whatAvail = Math.max(8, caps.width - FINDING_INDENT.length);
  for (const line of wrap(f.what, whatAvail)) out.push(`${FINDING_INDENT}${line}`);
  if (f.note !== undefined) out.push(...findingLabeledLines("note", f.note, caps));
  if (f.fix !== undefined) out.push(...findingLabeledLines("fix", f.fix, caps));
  return out;
}

export type MatchView = {
  readonly rank: number;
  readonly title: string;
  readonly path: string;
  readonly breadcrumb?: string;
  readonly snippet?: string;
  readonly sourceRef?: string;
};

/**
 * Render one search match: `rank  title` on the left with `path` right-aligned
 * to the terminal width, then optional indented breadcrumb (`›`), snippet, and
 * a compact source ref. Ranking telemetry and facts live in `--json`.
 */
export function match(m: MatchView, caps: Caps): ReadonlyArray<string> {
  const left = `  ${m.rank}  `;
  const indent = " ".repeat(left.length);
  const gap = 2;
  const pathWidth = visibleWidth(m.path);
  const titleBudget = Math.max(4, caps.width - left.length - pathWidth - gap);
  const title = truncate(m.title, titleBudget, caps.unicode);
  const used = left.length + visibleWidth(title);
  const spacer = " ".repeat(Math.max(gap, caps.width - used - pathWidth));
  const out: string[] = [`${left}${title}${spacer}${paint(m.path, "muted", caps)}`];
  if (m.breadcrumb !== undefined) {
    out.push(`${indent}${paint(`› ${m.breadcrumb}`, "muted", caps)}`);
  }
  if (m.snippet !== undefined) {
    for (const line of wrap(m.snippet, Math.max(8, caps.width - indent.length))) {
      out.push(`${indent}${line}`);
    }
  }
  if (m.sourceRef !== undefined) {
    out.push(`${indent}${paint(m.sourceRef, "ident", caps)}`);
  }
  return out;
}

export type Cell = { readonly text: string; readonly tone?: Tone };
export type Column<R> = {
  readonly header: string;
  readonly get: (row: R) => Cell;
  readonly priority: number; // higher = dropped first under width pressure (reserved; v1 shrinks instead)
  readonly align?: "left" | "right";
};

const INDENT = 2;
const COL_GAP = 2;

export function table<R>(
  rows: ReadonlyArray<R>,
  columns: ReadonlyArray<Column<R>>,
  caps: Caps,
): ReadonlyArray<string> {
  if (rows.length === 0) return [`  ${paint("(no rows)", "muted", caps)}`];

  const widths = columns.map((col) =>
    Math.max(
      visibleWidth(col.header),
      ...rows.map((r) => visibleWidth(col.get(r).text)),
    ),
  );

  // Shrink the widest column until the row fits caps.width. Never drop columns in v1.
  const fixed = INDENT + COL_GAP * (columns.length - 1);
  let total = fixed + widths.reduce((a, b) => a + b, 0);
  while (total > caps.width) {
    // Ties resolve to the left-most widest column (deterministic).
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 4) break; // floor
    widths[widest]!--;
    total--;
  }

  const renderCells = (cells: ReadonlyArray<Cell>): string => {
    const parts = cells.map((c, i) => {
      const w = widths[i]!;
      const align = columns[i]!.align ?? "left";
      const clipped = truncate(c.text, w, caps.unicode);
      // Don't pad a left-aligned final column — avoids trailing whitespace.
      const isLastLeft = i === cells.length - 1 && align === "left";
      const sized = isLastLeft ? clipped : pad(clipped, w, align);
      return c.tone !== undefined ? paint(sized, c.tone, caps) : sized;
    });
    return " ".repeat(INDENT) + parts.join(" ".repeat(COL_GAP));
  };

  const header = renderCells(
    columns.map((c) => ({ text: c.header, tone: "muted" as Tone })),
  );
  const body = rows.map((r) => renderCells(columns.map((c) => c.get(r))));
  return [header, ...body];
}
