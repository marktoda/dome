// dome.daily.close-scaffold — the evening close (daily-surface D4).
//
// The deterministic scaffold drafts the dome.daily:close block under ## Done
// in TODAY's daily: done candidates (settled surface copies + direct settles,
// deduped by body), the still-open line-up (count + top 3 in surface order),
// and a story pointer — never story prose. Presence-gated idempotency: the
// block is written only when absent, so re-runs no-op and a human-deleted
// candidate is never resurrected. No daily → clean no-op.
// Normative: [[wiki/specs/daily-surface]] §"The close block".

import { describe, expect, test } from "bun:test";

import closeScaffold from "../../assets/extensions/dome.daily/processors/close-scaffold";
import { dailyPath, dailyPathSettings, localDateParts } from "../../assets/extensions/dome.daily/processors/daily-paths";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("8888888888888888888888888888888888888888");
const TREE = treeOid("9999999999999999999999999999999999999999");
// The close's evening window is vault-LOCAL ([21:30, midnight)), so the
// fixture fire time is built from local components — TZ-robust.
const FIRED_AT = new Date(2026, 5, 5, 21, 45).toISOString();
const MORNING_MISFIRE_AT = new Date(2026, 5, 5, 9, 0).toISOString();

const SETTINGS = dailyPathSettings(undefined);
const TODAY_PATH = dailyPath(localDateParts(new Date(FIRED_AT)), SETTINGS);

const TODAY_DAILY = [
  "# 2026-06-05",
  "",
  "## Start Here",
  "",
  "## Open Loops",
  "",
  "<!-- dome.daily:open-loops:start -->",
  "### Source-backed Open Loops",
  "- [ ] Draft the rollout plan (from [[wiki/projects/alpha]])",
  "- [ ] Review the audit findings (from [[wiki/projects/beta]])",
  "- [ ] Ping legal about the filing (from [[wiki/people/dana]])",
  "- [ ] Refresh the metrics dashboard (from [[wiki/projects/gamma]])",
  "",
  "### Resolved Today",
  "- [x] Sent Ada the staffing note (from [[wiki/projects/alpha]])",
  "",
  "### Dismissed Today",
  "- [-] Chase the stale vendor quote (from [[wiki/projects/beta]])",
  "<!-- dome.daily:open-loops:end -->",
  "",
  "## Notes",
  "",
  "- [x] Booked the offsite room",
  "- [ ] Still-open capture stays out of Done",
  "",
  "## Decisions",
  "",
  "## Done",
  "",
  "## Story of the Day",
  "",
].join("\n");

async function runCloseScaffold(
  files: Readonly<Record<string, string>>,
  input: unknown = { kind: "schedule", cron: "30 21 * * *", firedAt: FIRED_AT },
): Promise<{
  readonly patch: PatchEffect | undefined;
  readonly written: string | null;
}> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-close-scaffold",
    signal: new AbortController().signal,
    input,
  });
  const effects = await closeScaffold.run(ctx);
  const patch = effects.find(
    (effect): effect is PatchEffect => effect.kind === "patch",
  );
  const change = patch?.changes.find((c) => String(c.path) === TODAY_PATH);
  return {
    patch,
    written: change?.kind === "write" ? change.content : null,
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("dome.daily.close-scaffold (D4)", () => {
  test("scaffolds done candidates, the still-open line-up, and the story pointer under ## Done", async () => {
    const { patch, written } = await runCloseScaffold({
      [TODAY_PATH]: TODAY_DAILY,
    });

    expect(patch).toBeDefined();
    expect(patch!.changes.map((c) => String(c.path))).toEqual([TODAY_PATH]);
    expect(written).not.toBeNull();
    expect(occurrences(written!, "<!-- dome.daily:close:start -->")).toBe(1);
    // The block lands inside the ## Done section, before ## Story of the Day.
    const doneAt = written!.indexOf("## Done");
    const blockAt = written!.indexOf("<!-- dome.daily:close:start -->");
    const storyAt = written!.indexOf("## Story of the Day");
    expect(doneAt).toBeGreaterThanOrEqual(0);
    expect(blockAt).toBeGreaterThan(doneAt);
    expect(storyAt).toBeGreaterThan(blockAt);

    // Done candidates: surface settles (with origin) + direct settles (no
    // origin), plain bullets only — never checkboxes.
    expect(written!).toContain("### Done today");
    expect(written!).toContain(
      "Candidates from today's settles — keep what counts, delete the rest.",
    );
    expect(written!).toContain(
      "- Sent Ada the staffing note (from [[wiki/projects/alpha]])",
    );
    expect(written!).toContain(
      "- Dismissed: Chase the stale vendor quote (from [[wiki/projects/beta]])",
    );
    expect(written!).toContain("- Booked the offsite room");
    // The block body renders plain bullets only — never checkboxes (which
    // the task extractors would re-ingest were the block not excluded).
    const blockBody = written!.slice(
      written!.indexOf("<!-- dome.daily:close:start -->"),
      written!.indexOf("<!-- dome.daily:close:end -->"),
    );
    expect(blockBody).not.toContain("- [x]");
    expect(blockBody).not.toContain("- [-]");
    expect(blockBody).not.toContain("- [ ]");
    expect(blockBody).not.toContain("Still-open capture stays out of Done");

    // Still open: count + top 3 in surface order.
    expect(written!).toContain("### Still open");
    expect(written!).toContain(
      "- 4 loops still open — top: Draft the rollout plan; Review the audit findings; Ping legal about the filing",
    );
    expect(written!).not.toContain("Refresh the metrics dashboard;");

    // Story pointer only — the close never writes story prose.
    expect(written!).toContain("### Story of the Day");
    expect(written!).toContain("The story stays yours");
  });

  test("no daily at close time is a clean no-op (the close never creates the skeleton)", async () => {
    const { patch } = await runCloseScaffold({});
    expect(patch).toBeUndefined();
  });

  test("non-schedule input is a no-op (schedule-only by design)", async () => {
    const { patch } = await runCloseScaffold(
      { [TODAY_PATH]: TODAY_DAILY },
      { kind: "signal", name: "document.changed" },
    );
    expect(patch).toBeUndefined();
  });

  test("a misfire collapsed to the morning is a no-op (the evening window gate)", async () => {
    // The scheduler collapses missed fires to one immediate fire; a host
    // that wakes mid-day must not scaffold a premature close the presence
    // gate would then protect all day.
    const { patch } = await runCloseScaffold(
      { [TODAY_PATH]: TODAY_DAILY },
      { kind: "schedule", cron: "30 21 * * *", firedAt: MORNING_MISFIRE_AT },
    );
    expect(patch).toBeUndefined();
  });

  test("presence-gated idempotency: a second run over the written daily emits no patch", async () => {
    const first = await runCloseScaffold({ [TODAY_PATH]: TODAY_DAILY });
    expect(first.written).not.toBeNull();
    const second = await runCloseScaffold({ [TODAY_PATH]: first.written! });
    expect(second.patch).toBeUndefined();
  });

  test("a human-deleted candidate is never resurrected", async () => {
    const first = await runCloseScaffold({ [TODAY_PATH]: TODAY_DAILY });
    expect(first.written).not.toBeNull();
    // The human deletes a candidate (it didn't count) and keeps the rest.
    const edited = first
      .written!.split("\n")
      .filter((line) => !line.includes("Booked the offsite room") ||
        line.includes("- [x]"))
      .join("\n");
    expect(edited).toContain("- [x] Booked the offsite room"); // origin line stays
    expect(occurrences(edited, "- Booked the offsite room")).toBe(0);

    const rerun = await runCloseScaffold({ [TODAY_PATH]: edited });
    expect(rerun.patch).toBeUndefined();
  });

  test("zero settles and a clear surface render the explicit empty scaffold", async () => {
    const quiet = [
      "# 2026-06-05",
      "",
      "## Start Here",
      "",
      "## Open Loops",
      "",
      "## Notes",
      "",
      "## Decisions",
      "",
      "## Done",
      "",
      "## Story of the Day",
      "",
    ].join("\n");
    const { written } = await runCloseScaffold({ [TODAY_PATH]: quiet });
    expect(written).not.toBeNull();
    expect(written!).toContain("Nothing recorded as settled today.");
    expect(written!).toContain("- No loops still open.");
  });
});

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-06-05T21:00:00.000Z",
            lastHumanChangedAt: "2026-06-05T21:00:00.000Z",
          },
  });
}
