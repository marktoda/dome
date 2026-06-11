// http/today-html: pure renderer — dome.daily.today/v1 structured data →
// a self-refreshing HTML cockpit page. No imports from the engine; consumed
// only by the HTTP adapter's GET /today route. Auto-refresh is a plain
// meta-refresh (the v1 plan's "dumb polling is acceptable" resolution); the
// page reloads its own URL, so a ?token= query parameter survives reloads.

export type TodayHtmlOptions = {
  readonly refreshSeconds: number;
};

export function renderTodayHtml(data: unknown, opts: TodayHtmlOptions): string {
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? esc(record.date) : "today";
  const openTasks = rows(record.openTasks);
  const followups = rows(record.followups);
  const questions = questionRows(record.questions);
  const total = openTasks.length + followups.length + questions.length;

  const body = total === 0
    ? `<p class="clear">All clear — nothing open.</p>`
    : [
        sectionHtml("Open tasks", openTasks.map(taskHtml)),
        sectionHtml("Follow-ups", followups.map(taskHtml)),
        sectionHtml(
          "Questions",
          questions.map(
            (q) =>
              `<li><span class="qid">#${q.id}</span> ${esc(q.question)}` +
              `<br><code>${esc(q.resolveCommand)}</code></li>`,
          ),
        ),
      ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.refreshSeconds))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dome today — ${date}</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 1.5rem auto; max-width: 42rem; padding: 0 1rem; background: #111; color: #eee; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; color: #9ad; }
  ul { padding-left: 1.2rem; } li { margin: .4rem 0; }
  code { background: #222; padding: .1rem .3rem; border-radius: 4px; font-size: .85em; }
  .muted { color: #888; font-size: .85em; } .qid { color: #fa6; }
  .clear { color: #6c6; font-size: 1.1rem; }
</style>
</head>
<body>
<h1>dome today <span class="muted">${date} · ${total} open</span></h1>
${body}
<p class="muted">auto-refreshes every ${Math.max(1, Math.floor(opts.refreshSeconds))}s</p>
</body>
</html>
`;
}

type TaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly dueDate: string | null;
};
type QuestionRow = { readonly id: number; readonly question: string; readonly resolveCommand: string };

function sectionHtml(title: string, items: ReadonlyArray<string>): string {
  if (items.length === 0) return "";
  return `<h2>${esc(title)} (${items.length})</h2>\n<ul>\n${items.join("\n")}\n</ul>`;
}

function taskHtml(t: TaskRow): string {
  const where = t.line === null ? t.path : `${t.path}:${t.line}`;
  const due = t.dueDate === null ? "" : ` <span class="muted">due ${esc(t.dueDate)}</span>`;
  return `<li>${esc(t.text)}${due} <span class="muted">${esc(where)}</span></li>`;
}

function rows(raw: unknown): ReadonlyArray<TaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const text = typeof r.text === "string" ? r.text : "";
    if (text.length === 0) return [];
    return [{
      text,
      path: typeof r.path === "string" ? r.path : "",
      line: typeof r.line === "number" ? r.line : null,
      dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
    }];
  });
}

function questionRows(raw: unknown): ReadonlyArray<QuestionRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const question = typeof r.question === "string" ? r.question : "";
    if (question.length === 0) return [];
    return [{
      id: typeof r.id === "number" ? r.id : 0,
      question,
      resolveCommand: typeof r.resolveCommand === "string" ? r.resolveCommand : "dome resolve <id> <value>",
    }];
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
