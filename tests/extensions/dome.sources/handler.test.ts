// sources.fetch — the dome.sources external handler (wiki/specs/sources.md
// §"The handler contract"), exercised with FAKE fetch commands only (tiny
// shell scripts in a temp vault — never a real model or network fetch).
//
// Pins the contract order: payload validation (defense in depth — the
// outbox row is data), output-already-on-disk crash recovery, spawn with
// cwd = vault root + appended <date> <output_path> args, non-zero exit →
// throw (stderr excerpt), exit-0-without-the-file → throw, abort → throw.
// The final block drives the handler through the REAL outbox dispatch so
// the bounded-retry semantics (pending → backoff-paced retry → sent) are
// pinned end to end (EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sourcesFetch from "../../../assets/extensions/dome.sources/external-handlers/sources.fetch";
import { externalActionEffect } from "../../../src/core/effect";
import { openOutboxDb, type OutboxDb } from "../../../src/outbox/db";
import {
  dispatchExternalEffect,
  type ExternalHandlerInput,
} from "../../../src/outbox/dispatch";

let vaultPath: string;

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "dome-sources-handler-"));
  mkdirSync(join(vaultPath, ".dome", "bin"), { recursive: true });
});

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true });
});

const PAYLOAD = {
  kind: "calendar",
  date: "2026-06-10",
  output_path: "sources/calendar/2026-06-10.md",
} as const;

function input(
  overrides: Partial<ExternalHandlerInput> & { readonly payload: unknown },
): ExternalHandlerInput {
  return {
    capability: "sources.fetch",
    idempotencyKey: "dome.sources:calendar:2026-06-10",
    sourceRefs: [],
    runId: "run-handler-test",
    attempt: 1,
    signal: new AbortController().signal,
    vaultPath,
    ...overrides,
  };
}

/** Install a fake fetch script and return the subscription-style command. */
function fakeCommand(script: string): ReadonlyArray<string> {
  const path = join(vaultPath, ".dome", "bin", "fake-fetch.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return [".dome/bin/fake-fetch.sh"];
}

describe("sources.fetch handler contract", () => {
  test("spawns the command from the vault root with date + output path appended", async () => {
    const command = fakeCommand(
      // Record the args + cwd, then fulfil the contract by writing $2.
      'printf "%s|%s|%s" "$1" "$2" "$(pwd)" > args.txt\nmkdir -p "$(dirname "$2")"\necho agenda > "$2"',
    );
    const result = await sourcesFetch(
      input({ payload: { ...PAYLOAD, command } }),
    );

    expect(result).toEqual({ externalId: "calendar:2026-06-10" });
    const recorded = await Bun.file(join(vaultPath, "args.txt")).text();
    const [date, outputPath, cwd] = recorded.split("|");
    expect(date).toBe("2026-06-10");
    expect(outputPath).toBe("sources/calendar/2026-06-10.md");
    // Resolve via realpath-insensitive suffix check (tmpdir may be symlinked).
    expect(cwd?.endsWith(vaultPath.split("/").slice(-1)[0]!)).toBe(true);
  });

  test("output already on disk returns recovered without spawning", async () => {
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, "sources", "calendar", "2026-06-10.md"),
      "# already fetched\n",
    );
    // A command that would explode if spawned proves the no-spawn path.
    const command = fakeCommand("echo should-not-run > spawned.txt\nexit 1");

    const result = await sourcesFetch(
      input({ payload: { ...PAYLOAD, command } }),
    );
    expect(result).toEqual({
      externalId: "calendar:2026-06-10",
      recovered: true,
    });
    expect(await Bun.file(join(vaultPath, "spawned.txt")).exists()).toBe(false);
  });

  test("non-zero exit throws with the stderr excerpt (ordinary outbox retry)", async () => {
    const command = fakeCommand('echo "calendar API said no" >&2\nexit 7');
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/exited 7.*calendar API said no/s);
  });

  test("exit 0 without the output file throws — a silent no-op fetch is visible", async () => {
    const command = fakeCommand("exit 0");
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/exited 0 but did not write sources\/calendar\/2026-06-10\.md/);
  });

  test("the dispatch AbortSignal kills the child and the attempt throws", async () => {
    const command = fakeCommand("sleep 30");
    const controller = new AbortController();
    const pending = sourcesFetch(
      input({ payload: { ...PAYLOAD, command }, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  test("requires the engine-injected vaultPath (bundle-handler wrapping)", async () => {
    const base = input({ payload: { ...PAYLOAD, command: ["true"] } });
    const { vaultPath: _omitted, ...withoutVault } = base;
    await expect(sourcesFetch(withoutVault)).rejects.toThrow(/vaultPath/);
  });

  test("re-rejects payloads that could escape the vault (the row is data)", async () => {
    const cases: ReadonlyArray<unknown> = [
      null,
      { ...PAYLOAD },                                            // no command
      { ...PAYLOAD, command: [] },                               // empty command
      { ...PAYLOAD, command: ["x"], kind: "" },                  // empty kind
      { ...PAYLOAD, command: ["x"], date: "June 10" },           // bad date
      { ...PAYLOAD, command: ["x"], output_path: "/etc/x.md" },  // absolute
      { ...PAYLOAD, command: ["x"], output_path: "../x.md" },    // escape
      { ...PAYLOAD, command: ["x"], output_path: "a\\b.md" },    // backslash
    ];
    for (const payload of cases) {
      await expect(sourcesFetch(input({ payload }))).rejects.toThrow();
    }
  });
});

describe("sources.fetch through the real outbox (retry semantics)", () => {
  let db: OutboxDb;

  beforeEach(async () => {
    const opened = await openOutboxDb({
      path: join(vaultPath, ".dome", "state", "outbox.db"),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("outbox open failed");
    db = opened.value.db;
  });

  afterEach(() => {
    db.close();
  });

  test("failing fetch lands pending with backoff; the retry pump re-dispatches to sent", async () => {
    // Fail until the marker file exists, then succeed — two real attempts.
    const command = fakeCommand(
      'if [ ! -f attempt.marker ]; then touch attempt.marker; echo "transient" >&2; exit 1; fi\nmkdir -p "$(dirname "$2")"\necho agenda > "$2"',
    );
    const effect = externalActionEffect({
      capability: "sources.fetch",
      idempotencyKey: "dome.sources:calendar:2026-06-10",
      payload: { ...PAYLOAD, command },
      sourceRefs: [],
    });
    const handlers = new Map([
      [
        "sources.fetch",
        (handlerInput: ExternalHandlerInput) =>
          sourcesFetch({ ...handlerInput, vaultPath }),
      ],
    ]);

    const t0 = new Date("2026-06-10T05:15:00.000Z");
    const first = await dispatchExternalEffect(db, {
      effect,
      runId: "run-1",
      handlers,
      now: t0,
    });
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") throw new Error("expected pending");
    expect(first.attempts).toBe(1);
    expect(first.lastError).toContain("transient");

    // The 15-minute fetch tick re-emits the same key; before the backoff
    // cursor the row is left alone (already-pending rows are only retried
    // once next_attempt_at passes), after it the retry succeeds.
    const afterBackoff = new Date(first.nextAttemptAt);
    const second = await dispatchExternalEffect(db, {
      effect,
      runId: "run-2",
      handlers,
      now: new Date(afterBackoff.getTime() + 1000),
    });
    expect(second.kind).toBe("sent");
    if (second.kind !== "sent") throw new Error("expected sent");
    expect(second.externalId).toBe("calendar:2026-06-10");

    // A third emission returns the cached result without re-spawning.
    const third = await dispatchExternalEffect(db, {
      effect,
      runId: "run-3",
      handlers,
      now: new Date(afterBackoff.getTime() + 2000),
    });
    expect(third.kind).toBe("already-sent");
  });
});
