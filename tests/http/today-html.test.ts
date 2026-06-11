// The pure today→HTML cockpit renderer: structured dome.daily.today/v1 data
// in, a self-refreshing escaped HTML page out. No vault, no engine — the
// renderer is a pure function, so these tests are plain string assertions.

import { describe, expect, test } from "bun:test";

import { renderTodayHtml } from "../../src/http/today-html";

const DATA = {
  schema: "dome.daily.today/v1",
  date: "2026-06-11",
  counts: { openTasks: 1, followups: 0, questions: 1 },
  openTasks: [
    { text: "ship <the> cockpit", path: "wiki/dailies/2026-06-11.md", line: 5, dueDate: null, followup: false },
  ],
  followups: [],
  questions: [
    { id: 7, question: "Merge A into B?", resolveCommand: "dome resolve 7 yes" },
  ],
};

describe("renderTodayHtml", () => {
  test("renders sections, escapes HTML, includes meta refresh", () => {
    const html = renderTodayHtml(DATA, { refreshSeconds: 15 });
    expect(html).toContain('<meta http-equiv="refresh" content="15">');
    expect(html).toContain("ship &lt;the&gt; cockpit");      // escaped
    expect(html).toContain("2026-06-11");
    expect(html).toContain("Merge A into B?");
    expect(html).toContain("dome resolve 7 yes");
    expect(html).not.toContain("<the>");                      // no raw injection
  });

  test("floors refreshSeconds at 1 and truncates fractions", () => {
    expect(renderTodayHtml(DATA, { refreshSeconds: 0 })).toContain('content="1"');
    expect(renderTodayHtml(DATA, { refreshSeconds: 2.9 })).toContain('content="2"');
  });

  test("tolerates malformed data with an empty-state page", () => {
    const html = renderTodayHtml(null, { refreshSeconds: 15 });
    expect(html).toContain("All clear");
  });
});
