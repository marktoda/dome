// scenarios/effect-kinds/ingest-scheduled-recovery.scenario.test.ts
//
// dome.agent.ingest is a level-triggered reconciler: it ingests the STANDING
// contents of inbox/raw/ (not just the commit delta) and carries an hourly
// `schedule` trigger (cron "0 * * * *") alongside its inbox/raw signals. This
// scenario proves the wiring end-to-end: a committed capture that the SIGNAL
// path never lifted is recovered by a SCHEDULED (cron) tick.
//
// Isolation of the scheduled path:
//   The capture ships in `initialFiles`, so it lives in the baseline commit.
//   The first adoption has no "previous" to diff against, so NO file.created /
//   document.changed signal ever fires for inbox/raw/*.md — the signal path is
//   structurally blind to it. The ONLY trigger that can reach this capture is
//   ingest's schedule trigger. We pin that distinction by asserting the single
//   ingest run that lifted the capture carries `trigger_kind = 'schedule'`
//   (the runs-ledger column the scheduler stamps), not `'signal'`. Removing the
//   cron trigger from the manifest would leave the capture stranded forever:
//   no signal, no schedule, no lift. (The per-step lift/archive behavior — the
//   tool-call loop, the bound, the backlink stamping — is covered by the
//   processor-level tests in tests/extensions/dome.agent/ingest.test.ts; this
//   scenario covers the cron→ingest reach through the real engine + tool seam.)
//
// The model is the shared scripted step provider (fixtures/model-providers/
// captured-ingest-step.ts): per source it appends one `- [ ] #task …` line to
// today's daily, then archiveSource()s the raw capture out of inbox/raw/.

import { expect } from "bun:test";
import { join } from "node:path";

import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
} from "../../../../assets/extensions/dome.daily/processors/daily-paths";
import { readBlob } from "../../../../src/git";
import { TestClock, scenario } from "../../index";

// Reuse the canonical capture→ingest step script: it appends the task line then
// archives the source, parsing both paths out of the task turn (so it is
// timezone- and config-agnostic). A fresh process per step — state lives in the
// message history the harness threads back in.
const STEP_PROVIDER = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "model-providers",
  "captured-ingest-step.ts",
);

const TASK_BODY = "call the landlord about the radiator";
const RAW = "inbox/raw/2026-06-16-1200-note.md";
const PROCESSED = "inbox/processed/2026-06-16-1200-note.md";

// Bundle grants mirror the shipped dome.agent / dome.daily manifests; the read
// grant covers inbox/raw/** so the reconciler's listMarkdownFiles() surfaces
// the standing capture, and inbox/processed/* + wiki/dailies/* so it can write
// the lifted task and archive the source.
const CONFIG = `
model_provider:
  kind: command
  command: ["bun", ${JSON.stringify(STEP_PROVIDER)}]
extensions:
  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/*.md"
      patch.auto:
        - "wiki/**/*.md"
        - "wiki/dailies/*.md"
        - "notes/*.md"
      graph.write:
        - "dome.daily.*"
        - "dome.attention.*"
      question.ask: true
  dome.agent:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "inbox/**/*.md"
        - "index.md"
        - "log.md"
        - "core.md"
        - "preferences/signals.md"
      patch.auto:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
        - "preferences/signals.md"
      graph.write:
        - "dome.preference.*"
      model.invoke:
        maxDailyCostUsd: 5
      question.ask: true
`;

scenario(
  {
    name: "effect-kinds: a scheduled tick recovers a committed capture the signal path never lifted",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "route", route: "garden-schedule" },
    ],
    harness: {
      // 12:30 local — mid-hour, so the cron "0 * * * *" next-fire boundary is
      // an unambiguous 13:00 for the advance-past-the-hour drain below.
      clock: new TestClock("2026-06-16T12:30:00.000Z"),
      bundles: ["dome.daily", "dome.agent"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
        // Committed-and-adopted via the baseline commit. No delta ⇒ no
        // inbox/raw signal ever fires for it: the signal path is blind here.
        [RAW]: TASK_BODY,
      },
    },
  },
  async (h) => {
    const todayPath = dailyPath(
      localDateParts(h.clock.now()),
      dailyPathSettings(undefined),
    );

    // Baseline tick: adopt the config + baseline commit. The schedule trigger
    // is due (ingest has no prior cursor/ledger history → the scheduler's
    // "missed every interval, collapse to one fire now" rule), so the cron
    // path fires ingest against the STANDING inbox and lifts the capture. The
    // signal path contributes nothing — there was no commit delta to signal.
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);
    // A second tick drains the garden cascade (stamp-block-id anchors the new
    // task line) to a fixed point.
    await h.tick();

    // Exactly ONE ingest run, and it was SCHEDULE-triggered — the proof that
    // the cron path (not a signal) recovered the capture.
    const ingestRuns = h.ledger.raw
      .query<{ status: string; trigger_kind: string }, [string]>(
        "SELECT status, trigger_kind FROM runs WHERE processor_id = ? ORDER BY started_at ASC",
      )
      .all("dome.agent.ingest");
    expect(ingestRuns).toEqual([{ status: "succeeded", trigger_kind: "schedule" }]);

    // The task for the capture landed in today's daily note …
    await h.expectFile(todayPath).toContain(`- [ ] #task ${TASK_BODY}`);
    // … with a backlink to the archived capture (origin tracking through the
    // real ingest tool seam).
    await h
      .expectFile(todayPath)
      .toMatch(
        new RegExp(
          `- \\[ \\] #task ${TASK_BODY} \\(\\[↗\\]\\(${PROCESSED}\\)\\)`,
        ),
      );

    // … and the capture is no longer in inbox/raw — it was archived to
    // inbox/processed (the inbox is ephemeral; the reconciler consumed it).
    await h.expectFile(RAW).toBeAbsent();
    await h.expectFile(PROCESSED).toExist();

    // Advance past the top of the hour and run the SCHEDULED drain explicitly
    // (the cron-trigger drain mechanism the wiring exists to serve). The
    // schedule trigger is due again at 13:00, so the scheduler fires ingest —
    // but the inbox is now empty, so the reconciler no-ops: the daily is not
    // doubled and the archive is not disturbed. Idempotent recovery.
    await h.advance(60 * 60 * 1000); // → 13:30, past the 13:00 cron boundary
    const drained = await h.drainOperationalWork();
    expect(drained.scheduler.fired.map((f) => f.processorId)).toContain(
      "dome.agent.ingest",
    );

    // The capture stays archived; no second ingest run touched the vault state.
    await h.expectFile(RAW).toBeAbsent();
    await h.expectFile(PROCESSED).toExist();
    const adopted = await h.refs.adopted();
    if (adopted === null) throw new Error("adopted ref missing after drain");
    const daily = await readBlob({
      path: h.vaultPath,
      commit: String(adopted),
      filepath: todayPath,
    });
    if (daily === null) throw new Error(`missing ${todayPath} at adopted`);
    // The task line appears exactly once (the empty-inbox scheduled drain did
    // not re-lift or duplicate it).
    const occurrences = daily.split(`#task ${TASK_BODY}`).length - 1;
    expect(occurrences).toBe(1);

    await h
      .expectLedger({ processorId: "dome.agent.ingest" })
      .toAllHaveStatus("succeeded");
  },
);
