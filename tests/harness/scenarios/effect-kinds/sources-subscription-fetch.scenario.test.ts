// scenarios/effect-kinds/sources-subscription-fetch.scenario.test.ts
//
// The dome.sources subscription loop end to end (wiki/specs/sources.md):
// an enabled subscription comes due → the scheduled fetch processor emits
// one ExternalActionEffect → the row lands in outbox.db BEFORE the handler
// runs (EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX) → the shipped bundle handler
// spawns the vault-configured FAKE fetch command (a tiny shell script —
// never a real model or network fetch) → the command writes + commits the
// calendar file as an ordinary non-engine commit → the daemon adopts it →
// the next fetch tick sees the file in the adopted snapshot and emits
// nothing (skip-if-present, the stateless done-marker).
//
// The first command attempt fails deliberately, so the scenario also pins
// the retry pump: the failed attempt leaves the row pending with backoff,
// and the NEXT 15-minute tick's re-emission of the same idempotency key is
// what retries it — no cursor, no special-case state.
//
// This scenario un-defers the `external` effect-kind and capability rows of
// the harness coverage matrix (tests/harness/meta/coverage-matrix.test.ts).

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { localDateOf } from "../../../../assets/extensions/dome.sources/processors/fetch";
import { scenario } from "../../index";

const PROCESSOR_ID = "dome.sources.fetch";

// The fake fetch command. Contract per wiki/specs/sources.md §"The handler
// contract": invoked from the vault root as `<command...> <date> <path>`,
// writes + commits the file, exits non-zero on failure. The first attempt
// fails (transient outage) via an untracked marker under .dome/state/.
const FAKE_FETCH_SH = `#!/bin/sh
set -eu
d="$1"
f="$2"
marker=".dome/state/sources-fetch-attempted"
if [ ! -f "$marker" ]; then
  mkdir -p "$(dirname "$marker")"
  : > "$marker"
  echo "transient calendar outage" >&2
  exit 1
fi
mkdir -p "$(dirname "$f")"
printf -- '---\\ntype: calendar-day\\ndate: %s\\n---\\n\\n# Calendar %s\\n\\n- 09:00 — Fake standup\\n' "$d" "$d" > "$f"
git add "$f"
# Hermetic identity + no signing: the developer's global git config (e.g.
# commit.gpgsign=true with a flaky gpg agent) must not reach the fake fetch.
git -c user.name="Fake Fetcher" -c user.email="fetch@example.com" \\
    -c commit.gpgsign=false \\
    commit -q --no-verify -m "calendar: agenda for $d"
`;

scenario(
  {
    name: "effect-kinds: sources subscription fetches through the outbox and the vault adopts the commit",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "external" },
      { kind: "capability", capability: "external" },
      { kind: "capability", capability: "read" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
    ],
    harness: {
      bundles: ["dome.sources"],
      initialFiles: {
        // Consent surface: subscription enabled + external grant. The
        // every-minute schedule keeps the scenario timezone-independent
        // (the cron's first local-day fire is always <= any firedAt).
        ".dome/config.yaml": `
extensions:
  dome.sources:
    enabled: true
    config:
      subscriptions:
        calendar:
          enabled: true
          schedule: "* * * * *"
          output_path: "sources/calendar/{date}.md"
          command: ["sh", ".dome/bin/fake-fetch.sh"]
    grant:
      read: ["sources/**/*.md", ".dome/config.yaml"]
      external: ["sources.fetch"]
`,
        ".dome/bin/fake-fetch.sh": FAKE_FETCH_SH,
      },
    },
  },
  async (h) => {
    const date = localDateOf(new Date(h.clock.nowMs()));
    const idempotencyKey = `dome.sources:calendar:${date}`;
    const outputPath = `sources/calendar/${date}.md`;

    // --- Tick 1: due + absent → effect → outbox row → first attempt fails.
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.expectOutbox().toHaveCount({ status: "pending" }).matching(1);
    const pendingRow = h.outbox.raw
      .query<
        { idempotency_key: string; capability: string; attempts: number; run_id: string | null; last_error: string | null },
        []
      >(
        "SELECT idempotency_key, capability, attempts, run_id, last_error FROM outbox",
      )
      .get();
    expect(pendingRow?.idempotency_key).toBe(idempotencyKey);
    expect(pendingRow?.capability).toBe("sources.fetch");
    expect(pendingRow?.attempts).toBe(1);
    expect(pendingRow?.run_id).not.toBeNull();
    expect(pendingRow?.last_error).toContain("transient calendar outage");
    expect(existsSync(join(h.vaultPath, outputPath))).toBe(false);
    // The emitting processor run itself succeeded — a transient fetch
    // failure is outbox state, not a processor failure.
    await h.expectLedger({ processorId: PROCESSOR_ID }).toAllHaveStatus("succeeded");

    // --- Tick 2+: the 15-minute cadence is the retry pump. Re-emitting the
    // same (kind, date) key finds the pending row past its backoff cursor
    // (1s real-time base delay — the sink dispatch path uses wall clock)
    // and performs the second attempt, which writes + commits. Backoff and
    // the 30s dispatching-claim window run on REAL time, so allow a few
    // ticks; extra ticks are harmless by design (INSERT OR IGNORE + the
    // already-sent cache).
    let fired = false;
    for (let tick = 0; tick < 5; tick += 1) {
      await Bun.sleep(1500);
      await h.advance(15 * 60_000);
      const drained = await h.drainOperationalWork();
      fired ||= drained.scheduler.fired.some(
        (fire) => fire.processorId === PROCESSOR_ID,
      );
      const sent = h.outbox.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'",
        )
        .get();
      if ((sent?.n ?? 0) > 0) break;
    }
    expect(fired).toBe(true);

    await h.expectOutbox().toHaveCount({ status: "sent" }).matching(1);
    await h.expectOutbox().toHaveCount().matching(1); // same row, no duplicate
    const sentRow = h.outbox.raw
      .query<{ external_id: string | null; attempts: number }, []>(
        "SELECT external_id, attempts FROM outbox WHERE status = 'sent'",
      )
      .get();
    expect(sentRow?.external_id).toBe(`calendar:${date}`);
    // `attempts` counts RECORDED FAILED attempts (markSent does not bump
    // the counter): one transient failure, then the successful retry.
    expect(sentRow?.attempts).toBe(1);
    expect(existsSync(join(h.vaultPath, outputPath))).toBe(true);

    // --- Tick 3: the command's commit is an ordinary non-engine commit the
    // daemon adopts through the normal Proposal path.
    const adoption = await h.tick();
    expect(adoption.adopted).toBe(true);

    // --- Tick 4: skip-if-present. The adopted file is the done marker —
    // the next due tick emits nothing and the outbox stays at one row.
    await h.advance(15 * 60_000);
    const idle = await h.drainOperationalWork();
    expect(idle.scheduler.fired.map((fire) => fire.processorId)).toContain(
      PROCESSOR_ID,
    );
    await h.expectOutbox().toHaveCount().matching(1);
    await h.expectLedger({ processorId: PROCESSOR_ID }).toAllHaveStatus("succeeded");
  },
);
