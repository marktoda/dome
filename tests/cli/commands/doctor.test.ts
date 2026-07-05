// `dome doctor` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { truncateSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../../../src/cli/commands/doctor";
import { ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY } from "../../../src/answers/db";

import { openLedgerDb } from "../../../src/ledger/db";
import {
  readModelProviderProbeCache,
} from "../../../src/engine/host/model-provider-probe-cache";

import {
  captured,
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
  seedRecurringOutboxFailure,
  seedRecurringTimeouts,
  seedUnhealthyOperationalState,
  writeDoctorConfig,
  writeDoctorConfigBody,
  type Fixture,
} from "./fixture";

installConsoleCapture();
installFixtureCleanup();

// ----- runDoctor ------------------------------------------------------------

describe("runDoctor", () => {
  test("clean vault reports ok", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const code = await runDoctor({ vault: f.vaultPath });
    expect(code).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("dome doctor");
    // New verdict: "healthy" for zero-finding vault
    expect(out).toMatch(/healthy/);
    // No ALLCAPS section headers in default mode
    expect(out).not.toMatch(/^\s+FINDINGS\s*$/m);
    expect(out).not.toMatch(/^\s+AT A GLANCE\s*$/m);
  });

  test("effective commit.gpgsign truthy raises the git.commit-signing info finding (status stays ok)", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    // The fixture insulates with local commit.gpgsign=false; flip it back
    // to model a vault inheriting global signing (the day-one hazard).
    // "yes" rather than "true": git accepts yes/on/1/true as boolean
    // spellings, and the probe must register all of them (--type=bool).
    execFileSync("git", ["-C", f.vaultPath, "config", "commit.gpgsign", "yes"]);

    expect(await runDoctor({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: {
        readonly infoCount: number;
        readonly gitCommitSigning: number;
      };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly severity: string;
        readonly message: string;
        readonly recovery: string;
      }>;
    };
    // Info severity: signing is the owner's call; the report stays ok.
    expect(parsed.status).toBe("ok");
    expect(parsed.summary.gitCommitSigning).toBe(1);
    const finding = parsed.findings.find(
      (row) => row.code === "git.commit-signing",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    // The message explains which paths are immune vs affected.
    expect(finding?.message).toContain("isomorphic-git");
    expect(finding?.message).toContain("commit.gpgsign=false");
    expect(finding?.recovery).toContain("git config --local commit.gpgsign false");
  });

  test("unset / false commit.gpgsign raises no git.commit-signing finding", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(await runDoctor({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly summary: { readonly gitCommitSigning: number };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(parsed.summary.gitCommitSigning).toBe(0);
    expect(
      parsed.findings.some((row) => row.code === "git.commit-signing"),
    ).toBe(false);
  });

  test("runs.db over the 512MB threshold raises the ledger.oversized warning", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const ledgerPath = join(f.vaultPath, ".dome", "state", "runs.db");
    const opened = await openLedgerDb({ path: ledgerPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.value.db.close();
    // Sparse-extend past the 512MB warning threshold without writing real
    // disk pages — the doctor probe only stats the file, and SQLite reads
    // only the pages its header records, so trailing zero bytes are inert.
    truncateSync(ledgerPath, 513 * 1024 * 1024);

    expect(await runDoctor({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: { readonly ledgerOversized: number };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly severity: string;
        readonly message: string;
        readonly recovery: string;
        readonly storage?: { readonly retainedForensicsRows: number | null };
      }>;
    };
    expect(parsed.summary.ledgerOversized).toBe(1);
    const finding = parsed.findings.find((row) => row.code === "ledger.oversized");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("512 MB");
    expect(finding?.recovery).toContain("ledger.retention_days");
    // The recovery must name the failure mode retention can't fix (both
    // remedies exempt failure forensics) and the detail carries the
    // retained-forensics count (0 on this fresh ledger) so the operator
    // isn't guessing which case they're in.
    expect(finding?.recovery).toContain("failure-forensics");
    expect(finding?.storage?.retainedForensicsRows).toBe(0);
  });

  test("a normal-sized runs.db raises no ledger.oversized finding", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(await runDoctor({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly summary: { readonly ledgerOversized: number };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(parsed.summary.ledgerOversized).toBe(0);
    expect(
      parsed.findings.some((row) => row.code === "ledger.oversized"),
    ).toBe(false);
  });

  test("--json reports failed outbox, orphan runs, and quarantines", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedUnhealthyOperationalState(f);

    const code = await runDoctor({
      vault: f.vaultPath,
      json: true,
      orphanThresholdMs: 0,
    });
    expect(code).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: {
        readonly findingCount: number;
        readonly failedOutbox: number;
        readonly orphanRuns: number;
        readonly failedRuns: number;
        readonly quarantinedProcessors: number;
      };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.findingCount).toBe(3);
    expect(parsed.summary.failedOutbox).toBe(1);
    expect(parsed.summary.orphanRuns).toBe(1);
    expect(parsed.summary.failedRuns).toBe(0);
    expect(parsed.summary.quarantinedProcessors).toBe(1);
    expect(parsed.findings.map((finding) => finding.code)).toEqual([
      "outbox.failed",
      "run.orphan",
      "processor.quarantined",
    ]);
  });

  test("--json raises a recurring-failure finding for an aged failed outbox row", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedRecurringOutboxFailure(f);

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: {
        readonly failedOutbox: number;
        readonly recurringOutboxFailures: number;
      };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly message: string;
      }>;
    };
    expect(parsed.status).toBe("unhealthy");
    // The aged row is BOTH a per-row failed finding and a recurring root-cause
    // finding — the recurring one carries the "fix the command" framing.
    expect(parsed.summary.failedOutbox).toBe(1);
    expect(parsed.summary.recurringOutboxFailures).toBe(1);
    const recurring = parsed.findings.find(
      (row) => row.code === "outbox.recurring-failure",
    );
    expect(recurring).toBeDefined();
    expect(recurring?.message.toLowerCase()).toContain("fails every run");
  });

  // ----- clean-rollup completeness (merged recurring-failure categories) -----
  //
  // The cleanCategories derivation must include ALL count fields that belong to
  // a category, not just the ones that existed before the recurring-failure
  // fields were added. Otherwise a vault with e.g. recurringTimeouts > 0 but
  // orphanRuns == 0 && failedRuns == 0 would falsely list "runs" in the all-clean
  // rollup while also raising a run.recurring-timeout finding.

  test("recurring-timeout finding does not leave 'runs' in the all-clean rollup", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedRecurringTimeouts(f);

    const code = await runDoctor({ vault: f.vaultPath });
    expect(code).toBe(0);
    const out = captured.out.join("\n");
    // The run.recurring-timeout finding must be present
    expect(out).toContain("run.recurring-timeout");
    // "runs" must NOT appear in the "all clean" rollup line
    expect(out).not.toMatch(/\bruns\b[^\n]*all clean/);
    // The rollup line itself may still exist (other categories are clean)
    expect(out).toMatch(/all clean/);
  });

  test("--json reports operational schema mismatches without opening runtime", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const runsPath = join(f.vaultPath, ".dome", "state", "runs.db");
    const old = new Database(runsPath);
    old.run(
      "CREATE TABLE ledger_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)",
    );
    old.run("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    old.run(
      "INSERT INTO ledger_meta (schema_hash, built_at) VALUES (?, ?)",
      ["unknown-ledger-schema", "2026-05-28T00:00:00.000Z"],
    );
    old.run("INSERT INTO runs (id) VALUES (?)", ["run-preserved"]);
    old.close();

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: {
        readonly operationalSchemaMismatch: number;
      };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly storage: { readonly stored: string | null };
      }>;
    };
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.operationalSchemaMismatch).toBe(1);
    expect(parsed.findings[0]?.code).toBe("operational.schema-mismatch");
    expect(parsed.findings[0]?.storage.stored).toBe("unknown-ledger-schema");

    const check = new Database(runsPath);
    try {
      const row = check
        .query<{ id: string }, []>("SELECT id FROM runs LIMIT 1")
        .get();
      expect(row?.id).toBe("run-preserved");
    } finally {
      check.close();
    }
  });

  test("--json: answers.db on the known pre-answered_by hash migrates instead of short-circuiting", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    // Hand-construct a legacy answers.db (schema hash from before the
    // `answered_by` column existed) — the exact scenario openAnswersDb's
    // `{kind:"migrate"}` policy upgrades in place on open. Mirrors the
    // legacy-DDL construction in tests/answers/db.test.ts.
    const answersPath = join(f.vaultPath, ".dome", "state", "answers.db");
    const legacy = new Database(answersPath, { create: true });
    legacy.run(
      "CREATE TABLE question_answers ("
        + "idempotency_key TEXT PRIMARY KEY,"
        + "answer TEXT NOT NULL,"
        + "answered_at TEXT NOT NULL,"
        + "question_id INTEGER,"
        + "question TEXT NOT NULL,"
        + "processor_id TEXT NOT NULL,"
        + "adopted_commit TEXT NOT NULL,"
        + "handler_status TEXT NOT NULL DEFAULT 'pending',"
        + "handler_attempts INTEGER NOT NULL DEFAULT 0,"
        + "last_handler_attempt_at TEXT,"
        + "handled_at TEXT,"
        + "last_handler_error TEXT"
        + ")",
    );
    legacy.run(
      "CREATE TABLE answers_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)",
    );
    legacy.run(
      "INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?)",
      [ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY, "2026-01-01T00:00:00.000Z"],
    );
    legacy.run(
      "INSERT INTO question_answers (idempotency_key, answer, answered_at, question_id, question, processor_id, adopted_commit) VALUES ('k1','yes','2026-06-01T00:00:00.000Z',1,'q?','p','c')",
    );
    legacy.close();

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: { readonly operationalSchemaMismatch: number };
    };
    // No short-circuit: the pre-open probe saw the known-migratable prior
    // hash as an info finding (not an error), so doctor proceeded to
    // openVaultRuntime, the migration ran, and the post-open schema probe
    // sees a matching hash — overall status is "ok".
    expect(parsed.status).toBe("ok");
    expect(parsed.summary.operationalSchemaMismatch).toBe(0);

    const migrated = new Database(answersPath, { readonly: true });
    try {
      const row = migrated
        .query<{ answered_by: string }, []>(
          "SELECT answered_by FROM question_answers WHERE idempotency_key = 'k1'",
        )
        .get();
      expect(row?.answered_by).toBe("owner");
    } finally {
      migrated.close();
    }
  });

  test("with --repair: exits 64 as a reserved V1 surface", async () => {
    const code = await runDoctor({ repair: true });
    expect(code).toBe(64);
    expect(captured.err.join("\n")).toContain("reserved in V1");
    expect(captured.err.join("\n")).toContain("dome resolve");
  });

  test("malformed --orphan-threshold-ms returns 64 before opening runtime", async () => {
    expect(await runDoctor({ orphanThresholdMs: "10x" })).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--orphan-threshold-ms must be a non-negative integer",
    );
  });

  // ----- model-provider probe ------------------------------------------------
  //
  // Per docs/wiki/specs/cli.md §"dome doctor": when .dome/config.yaml carries
  // a model_provider command stanza, doctor probes it with a cheap
  // dome.model-provider.probe/v1 envelope and reports reachability and
  // key-presence as separate findings.

  test("probe: configured and responsive provider with key present reports ok", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorProviderConfig(f, `
const request = JSON.parse(await Bun.stdin.text());
if (request.schema !== "dome.model-provider.probe/v1") {
  console.error("unexpected schema");
  process.exit(2);
}
console.log(JSON.stringify({
  schema: "dome.model-provider.probe/v1",
  ok: true,
  provider: "anthropic",
  keyPresent: true,
}));
`);

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const parsed = doctorJson();
    expect(parsed.status).toBe("ok");
    expect(parsed.summary.modelProviderUnreachable).toBe(0);
    expect(parsed.summary.modelProviderKeyMissing).toBe(0);
  });

  test("probe: responsive provider without a key raises model.provider-key-missing", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorProviderConfig(f, `
const key = process.env.DOME_TEST_DOCTOR_PROBE_KEY;
console.log(JSON.stringify({
  schema: "dome.model-provider.probe/v1",
  ok: true,
  provider: "anthropic",
  keyPresent: key !== undefined && key.length > 0,
}));
`);
    delete process.env.DOME_TEST_DOCTOR_PROBE_KEY;

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const parsed = doctorJson();
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.modelProviderKeyMissing).toBe(1);
    expect(parsed.summary.modelProviderUnreachable).toBe(0);
    const finding = parsed.findings.find(
      (row) => row.code === "model.provider-key-missing",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("credential");
    expect(finding?.recovery).toContain("ANTHROPIC_API_KEY");
  });

  test("probe: unspawnable provider command raises model.provider-unreachable", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(f, [
      "model_provider:",
      "  kind: command",
      "  command: [\"/nonexistent/dome-test-provider\"]",
      "extensions: {}",
      "",
    ].join("\n"));

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const parsed = doctorJson();
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.modelProviderUnreachable).toBe(1);
    const finding = parsed.findings.find(
      (row) => row.code === "model.provider-unreachable",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("spawn-failed");
    expect(finding?.recovery).toContain("dome.model-provider.probe/v1");

    // Doctor persists the probe outcome so `dome status` can report
    // last-known reachability without spawning the provider.
    const cache = readModelProviderProbeCache(f.vaultPath);
    expect(cache).not.toBeNull();
    expect(cache?.result.status).toBe("spawn-failed");
    expect(cache?.command).toEqual(["/nonexistent/dome-test-provider"]);
  });

  test("probe: pre-probe provider (non-zero exit) is treated as alive — no finding", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorProviderConfig(f, `
await Bun.stdin.text();
console.error("unsupported Dome model provider request schema");
process.exit(1);
`);

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const parsed = doctorJson();
    expect(parsed.summary.modelProviderUnreachable).toBe(0);
    expect(parsed.summary.modelProviderKeyMissing).toBe(0);
  });

  test("probe: pre-probe provider is visible as a muted info line in text output", async () => {
    // No finding (the documented classification stays), but text output must
    // not hide a non-zero-exit provider behind a clean report: a crashed
    // provider script answers exactly like a pre-probe one.
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorProviderConfig(f, `
await Bun.stdin.text();
console.error("unsupported Dome model provider request schema");
process.exit(1);
`);

    const code = await runDoctor({ vault: f.vaultPath });
    expect(code).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("MODEL PROVIDER");
    expect(out).toContain("unsupported (provider treated as alive; no finding)");
    // The stderr excerpt travels along so a crash is diagnosable in place.
    expect(out).toContain("exited 1");
    expect(out).toContain("unsupported Dome model provider request schema");
  });

  // ----- finding primitive rendering -----------------------------------------

  test("human mode renders findings via the finding primitive (new anatomy)", async () => {
    // Trigger a capability.grant-entry-missing finding by enabling dome.markdown
    // but omitting core.md from the read grant — same config trick as check test.
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runDoctor({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // New anatomy: severity-glyph + code (unicode=false in test env, so ASCII "!")
    // The capability finding should be present
    expect(out).toContain("capability.grant-entry-missing");
    // processor-id subject (not "config") via subjectFor()
    expect(out).toContain("dome.markdown.core-size");
    // Old run-on format must be gone
    expect(out).not.toContain("[warning]");
    expect(out).not.toMatch(/^\s+recovery:/m);
    // fix: labeled line must be present
    expect(out).toContain("fix    ");
  });

  test("human mode renders capability finding header with processor id, not 'config'", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runDoctor({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // The header must carry the processor id, not "config"
    expect(out).toContain("dome.markdown.core-size");
    expect(out).not.toMatch(/capability\.grant-entry-missing\s*[-·]\s*config/);
  });

  // ----- breakdown line dimZeros --------------------------------------------

  test("verbose: breakdown line still contains every term (dimZeros stable layout)", async () => {
    // seedUnhealthyOperationalState gives us findings, so the full dimZeros
    // breakdown is rendered in verbose mode. Verify every fixed term is present
    // even when most counts are zero (dimZeros must not drop terms).
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedUnhealthyOperationalState(f);

    expect(await runDoctor({ vault: f.vaultPath, orphanThresholdMs: 0, verbose: true })).toBe(0);
    const out = captured.out.join("\n");

    // All terms must be present in verbose output — none removed by dimZeros
    expect(out).toContain("outbox");
    expect(out).toContain("failed");
    expect(out).toContain("stuck");
    expect(out).toContain("orphans");
    expect(out).toContain("runs");
    expect(out).toContain("quarantine");
    expect(out).toContain("projection");
    expect(out).toContain("git");
    expect(out).toContain("instructions");
    expect(out).toContain("storage");
    expect(out).toContain("grants");
    expect(out).toContain("daily_path");
    expect(out).toContain("edition");
    expect(out).toContain("calendar");
    expect(out).toContain("model");
  });

  // ----- default vs verbose rendering (T9) ------------------------------------

  test("default: collapses breakdown to rollup, no ALLCAPS headers, no rule", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedUnhealthyOperationalState(f);

    expect(await runDoctor({ vault: f.vaultPath, orphanThresholdMs: 0 })).toBe(0);
    const out = captured.out.join("\n");

    // Zero-term wall gone from default (only visible in verbose)
    expect(out).not.toContain("0 stuck");
    // Rollup present in default
    expect(out).toMatch(/all clean/);
    // No ALLCAPS section wrappers
    expect(out).not.toMatch(/^\s+FINDINGS\s*$/m);
    expect(out).not.toMatch(/^\s+AT A GLANCE\s*$/m);
    // No full-width rule (10+ dash/─ run)
    expect(out).not.toMatch(/[-─]{10,}/);
  });

  test("verbose: restores full breakdown and finding why", async () => {
    // Trigger a capability.grant-entry-missing finding so there's a "why" field
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runDoctor({ vault: f.vaultPath, verbose: true })).toBe(0);
    const out = captured.out.join("\n");

    // Verbose restores the full dimZeros breakdown
    expect(out).toContain("AT A GLANCE");
    // Finding "why" labeled line is visible in verbose (detail rendered via findingLines verbose=true)
    expect(out).toMatch(/why\s/);
    // The why body explains the consequence (never fires — less likely to wrap at this point)
    expect(out).toContain("never fires");
  });

  test("default: findings are terse (no why)", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runDoctor({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // Default: no "why" lines shown
    expect(out).not.toContain("core-memory size lint");
    // But the finding itself is present
    expect(out).toContain("capability.grant-entry-missing");
  });
});

type DoctorProbeJson = {
  readonly status: string;
  readonly summary: {
    readonly modelProviderMissing: number;
    readonly modelProviderUnreachable: number;
    readonly modelProviderKeyMissing: number;
  };
  readonly findings: ReadonlyArray<{
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly recovery: string;
  }>;
};

function doctorJson(): DoctorProbeJson {
  const blob = captured.out.find((line) => line.includes("\"status\""));
  if (blob === undefined) throw new Error("expected doctor --json output");
  return JSON.parse(blob) as DoctorProbeJson;
}

/** Doctor fixture with a model_provider command stanza pointing at a
 * vault-local scripted provider (run via the test runtime's bun binary). */
async function writeDoctorProviderConfig(
  f: Fixture,
  providerSource: string,
): Promise<void> {
  const providerPath = join(f.vaultPath, ".dome", "provider.js");
  await writeFile(providerPath, providerSource, "utf8");
  await writeDoctorConfigBody(f, [
    "model_provider:",
    "  kind: command",
    `  command: [${JSON.stringify(process.execPath)}, ".dome/provider.js"]`,
    "extensions: {}",
    "",
  ].join("\n"));
}
