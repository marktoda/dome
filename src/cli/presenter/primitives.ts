import type { Caps } from "./caps";
import { bold, glyph, paint, statusGlyph, type Tone } from "./theme";
import { pad, visibleWidth } from "./width";

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
  return ["", paint(title.toUpperCase(), "muted", caps), ...body];
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
