// `dome today` — CLI wrapper over the dome.daily.today view. Hermetic:
// real temp vault, real sync, captured console (pattern from tests/http).

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { resolveCaps, stripWikilinks, visibleWidth } from "../../../src/cli/presenter";
import { formatTodayResult } from "../../../src/cli/commands/today";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runSync } from "../../../src/cli/commands/sync";
import { runToday } from "../../../src/cli/commands/today";
import { add, commit, initRepo } from "../../../src/git";

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...p: unknown[]) => { logs.push(p.map(String).join(" ")); };
  console.error = (...p: unknown[]) => { errors.push(p.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

let vault: string | null = null;

async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-today-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  const TODAY = localDateString();
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "dailies", `${TODAY}.md`),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] review the cockpit plan\n`,
    "utf8",
  );
  await add(vault, `wiki/dailies/${TODAY}.md`);
  await commit({ path: vault, message: "seed daily" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

describe("dome today", () => {
  test("renders the open-task surface", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runToday({ vault: v })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("review the cockpit plan");
  }, 120_000);

  test("--json emits the dome.daily.today/v1 document", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runToday({ vault: v, json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n"));
    expect(doc.schema).toBe("dome.daily.today/v1");
    expect(Array.isArray(doc.openTasks)).toBe(true);
  }, 120_000);

  test("--watch with --json is a usage error", async () => {
    expect(await runToday({ vault: await fixtureVault(), json: true, watch: true })).toBe(64);
  }, 120_000);
});

describe("dome today --watch", () => {
  test("renders, then skips re-print when output is unchanged", async () => {
    const v = await fixtureVault();
    logs = [];
    let clears = 0;
    const sleeps: number[] = [];
    const code = await runToday(
      { vault: v, watch: true, interval: 1 },
      {
        iterations: 3,
        sleep: async (ms) => { sleeps.push(ms); },
        clearScreen: () => { clears += 1; },
      },
    );
    expect(code).toBe(0);
    // Three renders, identical output → exactly one clear+print cycle.
    expect(clears).toBe(1);
    expect(sleeps).toEqual([1000, 1000]);
    expect(logs.join("\n")).toContain("review the cockpit plan");
  }, 120_000);

  test("re-clears and re-prints when output changes between iterations", async () => {
    logs = [];
    let clears = 0;
    const outputs = ["first render", "second render", "second render"];
    let i = 0;
    const code = await runToday(
      { watch: true, interval: 1 },
      {
        iterations: 3,
        sleep: async () => {},
        clearScreen: () => { clears += 1; },
        render: async () => ({ kind: "ok", text: outputs[i++] ?? "" }),
      },
    );
    expect(code).toBe(0);
    // First and second renders differ → two clear+print cycles; the
    // identical third render is skipped.
    expect(clears).toBe(2);
    const out = logs.join("\n");
    expect(out).toContain("first render");
    expect(out).toContain("second render");
  }, 120_000);

  test("an error mid-watch returns the render's exit code", async () => {
    const notAVault = mkdtempSync(join(tmpdir(), "dome-today-notavault-"));
    try {
      const onceCode = await runToday({ vault: notAVault });
      expect(onceCode).not.toBe(0);
      logs = [];
      const watchCode = await runToday(
        { vault: notAVault, watch: true, interval: 1 },
        { iterations: 1, sleep: async () => {}, clearScreen: () => {} },
      );
      expect(watchCode).toBe(onceCode);
    } finally {
      await rm(notAVault, { recursive: true, force: true });
    }
  }, 120_000);
});

// ----- dome today: not-installed error state ----------------------------------
//
// When dome.daily is not installed (disabled in config), the not-found path
// should render a verdict header + finding primitive instead of a bare run-on
// sentence. A vault where dome.daily is disabled reproduces this path.

describe("dome today: dome.daily not installed", () => {
  let noDailyVault: string | null = null;

  async function noDailyFixture(): Promise<string> {
    if (noDailyVault !== null) return noDailyVault;
    noDailyVault = mkdtempSync(join(tmpdir(), "dome-today-nodaily-"));
    // Initialize a minimal git repo with a .dome/config.yaml that explicitly
    // disables dome.daily so the today processor is not registered.
    await initRepo(noDailyVault);
    await mkdir(join(noDailyVault, ".dome", "state"), { recursive: true });
    await mkdir(join(noDailyVault, "wiki"), { recursive: true });
    // Config: dome.daily explicitly disabled; dome.graph still enabled
    // so the vault opens normally.
    await writeFile(
      join(noDailyVault, ".dome", "config.yaml"),
      [
        "extensions:",
        "  dome.graph:",
        "    enabled: true",
        "  dome.daily:",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    await writeFile(join(noDailyVault, "wiki/seed.md"), "seed\n");
    await commit({
      path: noDailyVault,
      message: "init no-daily vault\n",
      files: ["wiki/seed.md", ".dome/config.yaml"],
    });
    expect(await runSync({ vault: noDailyVault, quiet: true })).toBe(0);
    return noDailyVault;
  }

  afterAll(async () => {
    if (noDailyVault !== null) {
      await rm(noDailyVault, { recursive: true, force: true });
      noDailyVault = null;
    }
  });

  test("renders verdict header + finding instead of bare run-on sentence", async () => {
    const v = await noDailyFixture();
    logs = [];
    const code = await runToday({ vault: v });
    expect(code).toBe(64);
    const out = logs.join("\n");
    // Verdict header: contains "today" cmd and "not available" label.
    expect(out).toContain("today");
    expect(out).toContain("not available");
    // Finding header: error glyph (ASCII "x" in non-TTY) + code.
    expect(out).toContain("dome.daily not installed");
    // Fix line:
    expect(out).toContain("dome init --refresh-config");
    // Old bare run-on sentence must be gone.
    expect(out).not.toContain(
      "dome.daily is not installed or no today processor is enabled",
    );
    // --json path is unchanged: not tested here, but the human path is
    // confirmed above.
  }, 120_000);
});

// ----- dome today: Briefing terminal restyle (v2 presenter) -------------------
//
// These tests drive the new formatTodayResult shape: verdict-first headline,
// hero action line, glyph-grouped tasks, ? ask line, rollup, verbose gate.
// They use caps with unicode:false (ASCII glyphs) so assertions work without
// exact glyph matching.

const ASCII_CAPS = resolveCaps({ isTTY: false });

describe("dome today: Briefing terminal restyle", () => {
  test("verdict-first headline has 'today ·' and overdue/open verdict", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [
        { text: "review routing decision", path: "wiki/tasks.md", line: 1, dueDate: "2026-06-10" },
      ],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toMatch(/today\s*[·\-]\s*vault/);
    expect(out).toMatch(/overdue|open/);
    expect(out).not.toContain("dome decide");
  });

  test("hero task line renders with '>' pointer and urgency, no dome decide", () => {
    const data = {
      date: "2026-06-14",
      hero: {
        kind: "task",
        item: {
          text: "make the routing decision",
          path: "wiki/tasks.md",
          line: 1,
          dueDate: "2026-06-10",
        },
      },
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain(">");                          // ASCII pointer glyph
    expect(out).toContain("make the routing decision");
    expect(out).toMatch(/overdue/);
    expect(out).not.toContain("dome decide");
  });

  test("hero question line renders with '>' and dome resolve, no dome decide", () => {
    const data = {
      date: "2026-06-14",
      hero: {
        kind: "question",
        item: {
          id: 7,
          question: "K-budget gate a blocker?",
          resolveCommand: "dome resolve 7 yes",
          options: [],
        },
      },
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [
        {
          id: 7,
          question: "K-budget gate a blocker?",
          resolveCommand: "dome resolve 7 yes",
          options: [],
        },
      ],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain(">");
    expect(out).toContain("dome resolve");
    expect(out).not.toContain("dome decide");
  });

  test("full brief prose is hidden by default, shown under verbose", () => {
    const BRIEF = "A long analysis paragraph about today's priorities.";
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: {
        text: BRIEF,
        sourceRef: { path: "wiki/brief.md" },
      },
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const defaultOut = formatTodayResult(data, ASCII_CAPS, "/vault");
    const verboseOut = formatTodayResult(data, ASCII_CAPS, "/vault", { verbose: true });
    expect(defaultOut).not.toContain(BRIEF);
    expect(verboseOut).toContain(BRIEF);
    // Default output hints about --verbose
    expect(defaultOut).toContain("--verbose");
  });

  test("all-clear renders calm verdict with no tasks", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toMatch(/all clear/);
    expect(out).not.toContain("dome decide");
  });

  test("terminal all-clear renders the calm two-line body", () => {
    const out = formatTodayResult(
      { date: "2026-06-14", openTasks: [], followups: [], questions: [], counts: { openTasks: 0, followups: 0, questions: 0 }, brief: null, calendar: null, hero: null },
      ASCII_CAPS,
      "/vault",
    );
    expect(out).toMatch(/all clear/);
    expect(out).toMatch(/nothing open|inbox/i);
    expect(out).toMatch(/go make something|you're clear/i);
  });

  test("calendar summary line rendered when calendar present", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: {
        events: [
          { time: "10:00", title: "Team sync", meta: null },
          { time: "14:00", title: "Design review", meta: "30min" },
        ],
        sourceRef: { path: "wiki/calendar.md" },
      },
      openTasks: [],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toMatch(/today|2026-06-14/);
    expect(out).toMatch(/2\s*event/);
  });

  test("glyph-grouped task rows: overdue, today, open", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [
        { text: "overdue task", path: "wiki/tasks.md", line: 1, dueDate: "2026-06-10" },
        { text: "due today task", path: "wiki/tasks.md", line: 2, dueDate: "2026-06-14" },
        { text: "open task", path: "wiki/tasks.md", line: 3, dueDate: null },
      ],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    // Flat list: one task per line, urgency glyph leads each (ASCII: x/!/*).
    expect(out).toMatch(/\n\s+x overdue task/);
    expect(out).toMatch(/\n\s+! due today task/);
    expect(out).toMatch(/\n\s+\* open task/);
  });

  test("? ask line shows top question with dome resolve; +N if more", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [
        { id: 7, question: "K-budget gate a blocker?", resolveCommand: "dome resolve 7 yes", options: [] },
        { id: 8, question: "Second question", resolveCommand: "dome resolve 8 no", options: [] },
      ],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain("?");
    expect(out).toContain("K-budget gate a blocker?");
    expect(out).toContain("dome resolve 7");
    // Second question collapsed
    expect(out).not.toContain("Second question");
    expect(out).toContain("+1");
  });

  test("rollup line 'everything else clean' always appears when tasks exist", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [
        { text: "some task", path: "wiki/tasks.md", line: 1, dueDate: null },
      ],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain("everything else clean");
  });
});

// ----- stripWikilinks unit tests ---------------------------------------------

describe("stripWikilinks", () => {
  test("[[path|Alias]] → Alias", () => {
    expect(stripWikilinks("[[wiki/entities/robinhood-chain|Robinhood Chain]]")).toBe("Robinhood Chain");
  });

  test("[[path/to/page]] → last segment", () => {
    expect(stripWikilinks("[[wiki/entities/dinari]]")).toBe("dinari");
  });

  test("bare [[page]] → page", () => {
    expect(stripWikilinks("[[robinhood-chain]]")).toBe("robinhood-chain");
  });

  test("wikilinks embedded in sentence are replaced in-place", () => {
    expect(stripWikilinks("Ask [[wiki/entities/dinari|Dinari]]: can a pool work?")).toBe(
      "Ask Dinari: can a pool work?",
    );
  });

  test("multiple wikilinks in one string", () => {
    expect(
      stripWikilinks("[[wiki/x|X]] and [[wiki/y|Y]]"),
    ).toBe("X and Y");
  });

  test("no wikilinks → string unchanged (modulo trim)", () => {
    expect(stripWikilinks("plain label")).toBe("plain label");
  });

  test("collapses extra whitespace left by removal", () => {
    const result = stripWikilinks("Task: check  [[wiki/x]]  stuff");
    expect(result).toBe("Task: check x stuff");
  });
});

// ----- wikilink stripping in formatTodayResult --------------------------------

describe("dome today: wikilink stripping in rendered output", () => {
  test("hero task with wikilinks renders alias not raw markup", () => {
    const data = {
      date: "2026-06-14",
      hero: {
        kind: "task",
        item: {
          text: "Partner call: confirm [[wiki/entities/robinhood-chain|RH Chain]] launch",
          path: "wiki/tasks.md",
          line: 1,
          dueDate: "2026-06-10",
        },
      },
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain("RH Chain");
    expect(out).not.toContain("[[");
    expect(out).not.toContain("]]");
  });

  test("hero task overdue shows day count (overdue Nd), not bare 'overdue'", () => {
    const data = {
      date: "2026-06-14",
      hero: {
        kind: "task",
        item: {
          text: "Overdue task",
          path: "wiki/tasks.md",
          line: 1,
          dueDate: "2026-06-10",
        },
      },
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    // Should show "overdue 4d" (4 days from 2026-06-10 to 2026-06-14)
    expect(out).toMatch(/overdue \d+d/);
  });

  test("grouped task row truncates long label with ellipsis", () => {
    const longText =
      "Partner call: confirm RH Chain launch-day token catalog — which issuers should be on the initial list for the mainnet debut";
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [
        { text: longText, path: "wiki/tasks.md", line: 1, dueDate: "2026-06-10" },
      ],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    // The full text is NOT present verbatim (it's truncated to terminal width)
    expect(out).not.toContain(longText);
    // ASCII caps → ASCII ellipsis
    expect(out).toContain("...");
  });

  test("grouped task row strips wikilinks from label", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [
        {
          text: "Ask [[wiki/entities/dinari|Dinari]]: can a pool work?",
          path: "wiki/tasks.md",
          line: 1,
          dueDate: "2026-06-10",
        },
      ],
      followups: [],
      questions: [],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain("Dinari");
    expect(out).not.toContain("[[");
    expect(out).not.toContain("]]");
  });

  test("? ask question strips wikilinks", () => {
    const data = {
      date: "2026-06-14",
      hero: null,
      brief: null,
      calendar: null,
      openTasks: [],
      followups: [],
      questions: [
        {
          id: 7,
          question: "Is [[wiki/entities/robinhood-chain|RH Chain]] ready?",
          resolveCommand: "dome resolve 7 yes",
          options: [],
        },
      ],
      counts: {},
      dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toContain("RH Chain");
    expect(out).not.toContain("[[");
    expect(out).not.toContain("]]");
  });
});

describe("dome today: flat signal-led task list", () => {
  const mk = (text: string, dueDate: string | null) => ({ text, path: "wiki/t.md", line: 1, dueDate });
  test("lists tasks one per line, urgency-glyph-led, capped with +N more", () => {
    const open = Array.from({ length: 10 }, (_, i) => mk(`Open item ${i}`, null));
    const data = {
      date: "2026-06-14", hero: null, brief: null, calendar: null,
      openTasks: [mk("Overdue thing", "2026-06-01"), ...open], followups: [], questions: [],
      counts: { openTasks: 11 }, dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect(out).toMatch(/\n  x Overdue thing/);
    expect(out).toMatch(/\n  \* Open item 0/);
    expect(out).toMatch(/\d+ more · dome today --verbose/);
    expect(out).not.toContain("· +");
    expect(out).not.toMatch(/^\s+x overdue\s/m);
  });
  test("--verbose uncaps the list (no +N more)", () => {
    const open = Array.from({ length: 10 }, (_, i) => mk(`Open item ${i}`, null));
    const data = { date: "2026-06-14", hero: null, brief: null, calendar: null, openTasks: open, followups: [], questions: [], counts: { openTasks: 10 }, dueCounts: {} };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault", { verbose: true });
    expect(out).toContain("Open item 9");
    expect(out).not.toMatch(/more · dome today --verbose/);
  });
  test("the hero task is not repeated in the list", () => {
    const data = {
      date: "2026-06-14", brief: null, calendar: null, questions: [], followups: [],
      hero: { kind: "task", item: { text: "The hero task", path: "wiki/t.md", line: 1, dueDate: "2026-06-01" } },
      openTasks: [mk("The hero task", "2026-06-01"), mk("Another task", "2026-06-01")],
      counts: { openTasks: 2 }, dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    expect((out.match(/The hero task/g) || []).length).toBe(1);
    expect(out).toContain("Another task");
  });
  test("overflow count uses true totals not the display-limited list", () => {
    // doc with counts.openTasks = 234 but openTasks list (received) only has 8 rows, hero null
    // bucketed = 8 rows, cap = 7 shown → overflow from received list = 1 (wrong)
    // true overflow = 234 - 7 = 227 (correct)
    const data = {
      date: "2026-06-14", hero: null, brief: null, calendar: null,
      openTasks: Array.from({ length: 8 }, (_, i) => ({ text: `t${i}`, path: "p", line: i, dueDate: "2026-06-01" })),
      followups: [], questions: [],
      counts: { openTasks: 234, followups: 0, questions: 0 }, dueCounts: {},
    };
    const out = formatTodayResult(data, ASCII_CAPS, "/vault");
    // true overflow: 8 received overdue, 6 shown → 2 more overdue;
    // trueTotal=234, otherMore = (234−8)−0 = 226 → "226 more"
    expect(out).toContain("2 more overdue");
    expect(out).toContain("226 more");
    expect(out).toContain("dome today --verbose");
  });
});

describe("formatTodayResult grouping + links", () => {
  const caps = { color: false, unicode: true, width: 80, hyperlinks: false } as const;
  const doc = (over: Record<string, unknown> = {}) => ({
    date: "2026-06-15",
    openTasks: [
      { text: "Reply to Charlie re: Shankman bar-raiser · [thread](https://uniswapteam.slack.com/archives/C0B81NJU/p123)", path: "wiki/dailies/2026-06-15.md", line: 4, dueDate: "2026-06-13" },
      { text: "polish the AI recruiting round with Guillaume so the panel is consistent across domains", path: "p", line: 5, dueDate: "2026-06-15" },
      { text: "draft the Q3 plan", path: "p", line: 6, dueDate: null },
    ],
    followups: [],
    questions: [],
    counts: { openTasks: 3, followups: 0, questions: 0 },
    hero: null, brief: null, calendar: null,
    ...over,
  });

  test("renders OVERDUE/TODAY/OPEN headers only for non-empty buckets", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).toContain("OVERDUE");
    expect(out).toContain("TODAY");
    expect(out).toContain("OPEN");
  });

  test("pulls the slack URL out of the line — no raw archives/ URL, link label survives", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).not.toContain("archives/C0B81NJU");
    expect(out).not.toContain("https://uniswapteam.slack.com");
    expect(out).toContain("thread");
    expect(out).toContain("Reply to Charlie re: Shankman bar-raiser");
  });

  test("no task line is cut mid-word (no severed token before the ellipsis)", () => {
    const narrow = { ...caps, width: 44 };
    const out = formatTodayResult(doc(), narrow, "/v/work");
    for (const line of out.split("\n").filter((l) => l.includes("…"))) {
      const head = line.replace(/\s*….*$/, "");
      expect(/[\p{L}\p{N}):—\-]$/u.test(head.trimEnd())).toBe(true);
    }
  });

  test("honest overflow: many open tasks report a '… N more' line", () => {
    const out = formatTodayResult(doc({ counts: { openTasks: 50, followups: 0, questions: 0 } }), caps, "/v/work");
    expect(out).toMatch(/…\s.*more.*dome today --verbose/);
  });

  test("no rendered line exceeds caps.width even with link affordances", () => {
    const narrow = { color: false, unicode: true, width: 50, hyperlinks: true } as const;
    const out = formatTodayResult(doc(), narrow, "/v/work");
    for (const line of out.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(narrow.width);
    }
  });

  test("multi-link task rows never exceed caps.width", () => {
    const narrow = { color: false, unicode: true, width: 50, hyperlinks: true } as const;
    const multi = doc({
      openTasks: [
        {
          text: "sync with the team about the launch plan [thread](https://a/1) [doc](https://b/2) [pr](https://c/3)",
          path: "p", line: 1, dueDate: "2026-06-13",
        },
      ],
      counts: { openTasks: 1, followups: 0, questions: 0 },
    });
    const out = formatTodayResult(multi, narrow, "/v/work");
    for (const line of out.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(narrow.width);
  });

  test("a long link label is capped so the row fits caps.width", () => {
    const narrow = { color: false, unicode: true, width: 40, hyperlinks: true } as const;
    const longLabel = doc({
      openTasks: [
        {
          text: "do it [this is an extremely long link label that would blow the line](https://x/y)",
          path: "p", line: 1, dueDate: "2026-06-13",
        },
      ],
      counts: { openTasks: 1, followups: 0, questions: 0 },
    });
    const out = formatTodayResult(longLabel, narrow, "/v/work");
    for (const line of out.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(narrow.width);
  });

  test("the ask line shortens the question at a word boundary (no mid-word cut)", () => {
    const q = "should we escalate the routing retention decision to leadership before friday";
    const d = doc({
      openTasks: [],
      questions: [{ id: 7, question: q, resolveCommand: "dome resolve 7", options: [] }],
      counts: { openTasks: 0, followups: 0, questions: 1 },
    });
    const out = formatTodayResult(d, caps, "/v/work");
    const askLine = out.split("\n").find((l) => l.includes("#7"))!;
    expect(askLine).toContain("…");
    const shown = askLine.match(/#7 (.+?)…/)![1]!.trim();
    expect(q.startsWith(shown)).toBe(true);
    expect(q[shown.length]).toBe(" "); // the cut fell on a word boundary
  });
});

describe("today renders task origin as one affordance", () => {
  const caps = { color: false, unicode: true, width: 80, hyperlinks: true } as const;
  const doc = (over = {}) => ({
    date: "2026-06-15",
    openTasks: [
      { text: "reply to Jane re: pricing", path: "p", line: 1, dueDate: "2026-06-13", origin: "https://slk/p1" },
      { text: "fix the radiator", path: "p", line: 2, dueDate: "2026-06-13", origin: "inbox/processed/2026-06-14-radiator.md" },
    ],
    followups: [], questions: [], counts: { openTasks: 2, followups: 0, questions: 0 },
    hero: null, brief: null, calendar: null, ...over,
  });
  test("a URL origin renders one ↗ hyperlink to the URL", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).toContain("\x1b]8;;https://slk/p1\x1b\\↗\x1b]8;;\x1b\\");
  });
  test("a vault-path origin renders a file:// ↗ hyperlink", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).toContain("file:///v/work/inbox/processed/2026-06-14-radiator.md");
  });
  test("no origin → no affordance", () => {
    const out = formatTodayResult(doc({ openTasks: [{ text: "bare task", path: "p", line: 1, dueDate: "2026-06-13" }], counts: { openTasks: 1, followups: 0, questions: 0 } }), caps, "/v/work");
    const line = out.split("\n").find((l) => l.includes("bare task"))!;
    expect(line).not.toContain("↗");
  });
  test("origin affordance never pushes a line past caps.width", () => {
    const narrow = { color: false, unicode: true, width: 50, hyperlinks: true } as const;
    const out = formatTodayResult(doc(), narrow, "/v/work");
    for (const line of out.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(narrow.width);
  });
});
