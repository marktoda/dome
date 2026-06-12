// `dome doctor` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../../../src/cli/commands/doctor";

import {
  readModelProviderProbeCache,
} from "../../../src/engine/host/model-provider-probe-cache";

import {
  captured,
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
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
    expect(out).toContain("ok");
    expect(out).toContain("FINDINGS");
    expect(out).toContain("none");
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
