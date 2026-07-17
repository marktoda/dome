// `dome inspect` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { runInspect, INSPECT_COST_SCHEMA } from "../../../src/cli/commands/inspect";
import { runSync } from "../../../src/cli/commands/sync";
import {
  defaultConfigRecord,
  defaultConfigYaml,
} from "../../../src/cli/default-vault-config";

import {
  diagnosticEffect,
  questionEffect,
} from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { commit } from "../../../src/git";
import { recordCapabilityUse } from "../../../src/ledger/capability-uses";
import { openLedgerDb } from "../../../src/ledger/db";
import {
  insertQueued,
  markRunning,
  markSucceeded,
  newRunId,
} from "../../../src/ledger/runs";
import { effectHashCount } from "../../../src/processors/executor";
import { openProjectionDb } from "../../../src/projections/db";
import {
  insertDiagnostic,
} from "../../../src/projections/diagnostics";
import {
  applyQuestionAnswer,
  insertQuestion,
} from "../../../src/projections/questions";

import {
  captured,
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
  type Fixture,
} from "./fixture";

installConsoleCapture();
installFixtureCleanup();

// ----- runInspect -----------------------------------------------------------
//
// `dome inspect <subject>` is the v1.0 read surface for the operational
// substrate (renamed from the pre-recut `dome doctor --show <subject>`
// shape per [[wiki/specs/cli]] §"dome inspect"). Subject is positional,
// not a flag; each subject is backed by an existing runtime/query surface.

describe("runInspect", () => {
  test("subjects 'bundles' and 'processors' expose the loaded feature surface", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly processors: number;
      readonly adoption: number;
      readonly garden: number;
      readonly view: number;
      readonly command_views: number;
      readonly model_processors: number;
      readonly model: string;
    }>;
    const agentBundle = bundles.find((row) => row.bundle === "dome.agent");
    expect(agentBundle).toEqual(
      expect.objectContaining({
        processors: 11,
        adoption: 2,
        garden: 8,
        view: 1,
        model_processors: 3,
        model: "granted-no-provider",
      }),
    );
    const dailyBundle = bundles.find((row) => row.bundle === "dome.daily");
    expect(dailyBundle?.command_views).toBe(4);

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const processors = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly processor: string;
      readonly bundle: string;
      readonly version: string;
      readonly phase: string;
      readonly triggers: string;
      readonly commands: string;
      readonly capabilities: string;
      readonly bundle_grants: string;
      readonly grant_scopes: string;
      readonly grant_details: ReadonlyArray<{
        readonly kind: string;
        readonly scope: string;
        readonly values: ReadonlyArray<string>;
      }>;
      readonly execution: string;
      readonly model: string;
    }>;
    const ingest = processors.find(
      (row) => row.processor === "dome.agent.ingest",
    );
    expect(ingest).toEqual(
      expect.objectContaining({
        bundle: "dome.agent",
        version: "0.3.0",
        phase: "garden",
        triggers: "schedule,signal",
        execution: "llm",
        model: "granted-no-provider",
      }),
    );
    expect(ingest?.capabilities).toContain("model.invoke");
    expect(ingest?.bundle_grants).toContain("model.invoke");
    // core.md leads the sorted read scope (core memory is read-only by
    // design — it must never show up under patch.auto).
    expect(ingest?.grant_scopes).toContain("read:core.md,inbox/**/*.md");
    expect(ingest?.grant_scopes).toContain("wiki/**/*.md");
    expect(ingest?.grant_scopes).toContain("patch.auto:");
    // index.md/log.md are read-only for agents (the core.md grant shape):
    // the index regenerates from description: frontmatter, log.md is frozen.
    expect(ingest?.grant_details).toContainEqual({
      kind: "patch.auto",
      scope: "paths",
      values: [
        "inbox/processed/*.md",
        "inbox/raw/*.md",
        "notes/**/*.md",
        "preferences/signals.md",
        "wiki/**/*.md",
      ],
    });
    expect(ingest?.grant_details).toContainEqual({
      kind: "model.invoke",
      scope: "maxDailyCostUsd",
      values: ["5"],
    });

    const markdownRepair = processors.find(
      (row) => row.processor === "dome.markdown.repair-wikilinks",
    );
    expect(markdownRepair?.grant_scopes).toContain("patch.auto:**/*.md");

    const healthRecovery = processors.find(
      (row) => row.processor === "dome.health.outbox-recovery-questions",
    );
    expect(healthRecovery?.grant_scopes).toContain("read:**");
    expect(healthRecovery?.grant_scopes).toContain("outbox.read:failed");
    expect(healthRecovery?.grant_details).toContainEqual({
      kind: "outbox.read",
      scope: "statuses",
      values: ["failed"],
    });

    const query = processors.find(
      (row) => row.processor === "dome.search.query",
    );
    expect(query).toEqual(
      expect.objectContaining({
        phase: "view",
        triggers: "command",
        commands: "query",
        model: "none",
      }),
    );
    const taskBacklog = processors.find(
      (row) => row.processor === "dome.daily.task-backlog",
    );
    expect(taskBacklog).toEqual(
      expect.objectContaining({
        phase: "view",
        triggers: "command",
        commands: "task-backlog",
        model: "none",
      }),
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(0);
    const modelProcessors = JSON.parse(
      captured.out.join("\n"),
    ) as ReadonlyArray<{
      readonly processor: string;
      readonly model: string;
    }>;
    expect(modelProcessors.length).toBe(3);
    expect(modelProcessors.map((row) => row.processor).sort()).toEqual([
      "dome.agent.brief",
      "dome.agent.garden",
      "dome.agent.ingest",
    ]);
    expect(modelProcessors.every((row) => row.model !== "none")).toBe(true);
  });

  test("subject 'facts' exposes source-backed projection fact provenance", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeFile(
      join(f.vaultPath, "wiki/new.md"),
      "# New\n\nSee [[seed]] for the source note.\n",
    );
    await commit({
      path: f.vaultPath,
      message: "link seed note\n",
      files: ["wiki/new.md"],
    });

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        predicate: "dome.graph.links_to",
        subjectKind: "page",
        subjectId: "wiki/new.md",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly id: number;
      readonly subject: string;
      readonly predicate: string;
      readonly object: string;
      readonly assertion: string;
      readonly processor: string;
      readonly run: string;
      readonly adopted: string;
      readonly source_refs: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        subject: "page:wiki/new.md",
        predicate: "dome.graph.links_to",
        object: "seed",
        assertion: "extracted",
        processor: "dome.graph.links",
      }),
    );
    expect(rows[0]?.id).toBeGreaterThan(0);
    expect(rows[0]?.run).toMatch(/^run_/);
    expect(rows[0]?.adopted).toMatch(/^[0-9a-f]{40}$/);
    expect(rows[0]?.source_refs).toContain("wiki/new.md:3");

    captured.out = [];
    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        predicate: "dome.graph.tagged",
        json: true,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toEqual([]);
  });

  test("subject 'patches' exposes generated markdown change provenance", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );

    await writeFile(
      join(f.vaultPath, "wiki/messy.md"),
      "---\nid: messy\ntype: page\n---\n# Messy\n",
    );
    await commit({
      path: f.vaultPath,
      message: "add messy frontmatter\n",
      files: ["wiki/messy.md"],
    });

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "patches",
        vault: f.vaultPath,
        processor: "dome.markdown.normalize-frontmatter",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly id: number;
      readonly run: string;
      readonly processor: string;
      readonly phase: string;
      readonly status: string;
      readonly capability: string;
      readonly outcome: string;
      readonly paths: string;
      readonly input: string;
      readonly output: string;
      readonly effect_hashes: number;
    }>;
    const messyPatch = rows.find((row) => row.paths === "wiki/messy.md");
    expect(messyPatch).toBeDefined();
    expect(messyPatch).toEqual(
      expect.objectContaining({
        processor: "dome.markdown.normalize-frontmatter",
        phase: "adoption",
        status: "succeeded",
        capability: "patch.auto",
        outcome: "allowed",
        paths: "wiki/messy.md",
        effect_hashes: 1,
      }),
    );
    expect(messyPatch?.id).toBeGreaterThan(0);
    expect(messyPatch?.run).toMatch(/^run_/);
    expect(messyPatch?.input).toMatch(/^[0-9a-f]{12}$/);
    expect(messyPatch?.output).toMatch(/^[0-9a-f]{12}$/);

    captured.out = [];
    expect(
      await runInspect({
        subject: "patches",
        vault: f.vaultPath,
        processor: "dome.nope",
        json: true,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toEqual([]);
  });

  // Mass re-emission processors store a truncation sentinel past
  // EFFECT_HASHES_MAX (src/processors/executor.ts) instead of every hash.
  // The `patches` subject must report the true emitted-effect count, not the
  // stored list's length (which would undercount past the cap).
  test("subject 'patches' reports true effect-hash counts through the truncation sentinel", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    if (!ledger.ok) throw new Error(`ledger open failed: ${ledger.error.kind}`);
    const startedAt = new Date();
    const id = newRunId(startedAt);
    const hashes = [
      ...Array.from({ length: 100 }, (_, i) =>
        ("0".repeat(64) + i.toString(16)).slice(-64),
      ),
      "…+724 more effect hashes",
    ];
    insertQueued(ledger.value.db, {
      id,
      proposalId: null,
      processorId: "dome.test.mass-emit",
      processorVersion: "0.0.1",
      phase: "garden",
      inputCommit: commitOid(f.headSha),
      triggerKind: "schedule",
      triggerPayload: null,
      startedAt,
    });
    markRunning(ledger.value.db, id, startedAt);
    markSucceeded(ledger.value.db, {
      id,
      effectHashes: hashes,
      costUsd: null,
      durationMs: 10,
      outputCommit: null,
      finishedAt: startedAt,
    });
    recordCapabilityUse(ledger.value.db, {
      runId: id,
      capability: "patch.auto",
      resource: "wiki/a.md",
      outcome: "allowed",
      recordedAt: startedAt,
    });
    ledger.value.db.close();

    captured.out = [];
    expect(
      await runInspect({
        subject: "patches",
        vault: f.vaultPath,
        processor: "dome.test.mass-emit",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly effect_hashes: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.effect_hashes).toBe(824);
  });

  test("subject 'bundles' shows configured disabled bundles without loading them", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await mkdir(join(f.vaultPath, ".dome"), { recursive: true });
    // dome.agent ships enabled by default (product-review-3 Task 17); flip
    // it off explicitly here so the fixture still exercises the
    // disabled-bundle manifest-inspection path this test is about (metadata
    // surfaced straight from the manifest, no processor module imported).
    const rec = structuredClone(defaultConfigRecord()) as {
      extensions: Record<string, { enabled: boolean }>;
    };
    rec.extensions["dome.agent"]!.enabled = false;
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      stringifyYaml(rec),
    );

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly inventory: string;
      readonly version: string;
      readonly processors: number;
      readonly garden: number;
      readonly model_processors: number;
      readonly model: string;
    }>;
    const agent = bundles.find((row) => row.bundle === "dome.agent");
    expect(agent).toEqual(
      expect.objectContaining({
        status: "disabled",
        loaded: false,
        inventory: "manifest",
        version: "0.5.0",
        processors: 11,
        adoption: 2,
        garden: 8,
        view: 1,
        model_processors: 3,
        model: "disabled-no-provider",
      }),
    );
    const search = bundles.find((row) => row.bundle === "dome.search");
    expect(search).toEqual(
      expect.objectContaining({
        status: "enabled",
        loaded: true,
        processors: 3,
      }),
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const processors = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly processor: string;
    }>;
    expect(
      processors.some((row) => row.processor.startsWith("dome.agent.")),
    ).toBe(false);

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toEqual([]);

    captured.out = [];
    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(0);
    const modelBundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly model_processors: number;
      readonly model: string;
    }>;
    expect(modelBundles).toEqual([
      expect.objectContaining({
        bundle: "dome.agent",
        status: "disabled",
        loaded: false,
        model_processors: 3,
        model: "disabled-no-provider",
      }),
    ]);
  });

  test("subject 'bundles' shows the shipped default: dome.agent enabled, granted, no provider (Task 17)", async () => {
    // The literal `defaultConfigYaml()` a fresh `dome init` writes now ships
    // dome.agent enabled: true — the bundle loads and its model.invoke grant
    // resolves, but a scratch vault has no model_provider configured, so
    // `dome inspect bundles` must report "granted-no-provider", not the old
    // shipped "disabled-no-provider" shape.
    const f = await makeFixture();
    fixtures.push(f);
    await mkdir(join(f.vaultPath, ".dome"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      defaultConfigYaml(),
    );

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly model_processors: number;
      readonly model: string;
    }>;
    const agent = bundles.find((row) => row.bundle === "dome.agent");
    expect(agent).toEqual(
      expect.objectContaining({
        status: "enabled",
        loaded: true,
        model_processors: 3,
        model: "granted-no-provider",
      }),
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const processors = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly processor: string;
    }>;
    expect(
      processors.some((row) => row.processor.startsWith("dome.agent.")),
    ).toBe(true);
  });

  test("--model filter is only valid for bundle and processor metadata", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--model is only valid for the bundles and processors subjects",
    );
  });

  test("subject 'bundles' reads disabled local manifests without importing modules", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const bundleDir = join(f.vaultPath, ".dome", "extensions", "custom.disabled");
    await mkdir(join(bundleDir, "processors"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      [
        "extensions:",
        "  custom.disabled:",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify(
        {
          id: "custom.disabled",
          version: "1.2.3",
          processors: [
            {
              id: "custom.disabled.missing-module",
              version: "0.0.1",
              phase: "garden",
              triggers: [{ kind: "schedule", cron: "* * * * *" }],
              capabilities: [{ kind: "model.invoke", maxDailyCostUsd: 1 }],
              execution: { class: "llm" },
              module: "processors/missing-module.ts",
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly inventory: string;
      readonly version: string;
      readonly processors: number;
      readonly model_processors: number;
      readonly model: string;
    }>;
    expect(bundles).toContainEqual(
      expect.objectContaining({
        bundle: "custom.disabled",
        status: "disabled",
        loaded: false,
        inventory: "manifest",
        version: "1.2.3",
        processors: 1,
        model_processors: 1,
        model: "disabled-no-provider",
      }),
    );
  });

  test("subject 'runs' returns 0 on a fresh vault with a single-line verdict", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runInspect({ subject: "runs", vault: f.vaultPath });
    expect(code).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("no rows");
    // Empty result: collapses to one non-blank line.
    expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBe(1);
  });

  test("verdict header: non-empty result uses bullet glyph, empty result uses pending/muted glyph", async () => {
    // 'bundles' always returns rows (SDK ships first-party bundles).
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runInspect({ subject: "bundles", vault: f.vaultPath })).toBe(0);
    const withRows = captured.out.join("\n");
    // ASCII caps (non-TTY): bullet tone → "*", muted/pending tone → "o".
    // Unicode caps (TTY): bullet tone → "•", muted/pending tone → "○".
    // Test env is non-TTY → ASCII glyphs. The first line is the headline.
    const firstLine = withRows.split("\n")[0] ?? "";
    expect(firstLine).toContain("* "); // bullet glyph (info/plain tone)
    expect(firstLine).toContain("rows");

    captured.out = [];
    // 'questions' on a fresh vault has no rows.
    expect(await runInspect({ subject: "questions", vault: f.vaultPath })).toBe(0);
    const empty = captured.out.join("\n");
    const emptyFirstLine = empty.split("\n")[0] ?? "";
    expect(emptyFirstLine).toContain("o "); // pending glyph (muted tone)
    expect(emptyFirstLine).toContain("no rows");
  });

  test("subject 'diagnostics' returns source locations", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.diagnostic",
          message: "Needs a source location",
          sourceRefs: [
            sourceRef({
              commit: commitOid(f.headSha),
              path: "wiki/new.md",
              range: {
                startLine: 3,
                endLine: 5,
              },
            }),
          ],
        }),
        processorId: "test.cli",
        runId: "run-cli-diagnostic",
        proposalId: "prop_cli",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly id: number;
      readonly code: string;
      readonly processor: string;
      readonly run: string;
      readonly proposal: string;
      readonly adopted: string;
      readonly source_refs: string;
    }>;
    expect(rows[0]).toEqual(
      expect.objectContaining({
        code: "test.diagnostic",
        processor: "test.cli",
        run: "run-cli-diagnostic",
        proposal: "prop_cli",
      }),
    );
    expect(rows[0]?.id).toBeGreaterThan(0);
    expect(rows[0]?.adopted).toBe(f.headSha);
    expect(rows[0]?.source_refs).toContain("wiki/new.md:3-5");
  });

  test("diagnostics --summary groups by severity and code", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.repeated",
          message: "First repeated diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/new.md" }),
          ],
        }),
        processorId: "test.cli",
        proposalId: "prop_cli_summary",
        adoptedCommit: commitOid(f.headSha),
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.repeated",
          message: "Second repeated diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/seed.md" }),
          ],
        }),
        processorId: "test.cli",
        proposalId: "prop_cli_summary",
        adoptedCommit: commitOid(f.headSha),
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "error",
          code: "test.single",
          message: "Single diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/other.md" }),
          ],
        }),
        processorId: "test.other",
        proposalId: "prop_cli_summary",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        summary: true,
        json: true,
      }),
    ).toBe(0);
    const payload = JSON.parse(captured.out.join("\n")) as {
      readonly total: number;
      readonly group_count: number;
      readonly groups: ReadonlyArray<{
        readonly severity: string;
        readonly code: string;
        readonly count: number;
        readonly first_source_refs: string;
      }>;
    };
    expect(payload.total).toBe(3);
    expect(payload.group_count).toBe(2);
    expect(payload.groups[0]).toEqual(
      expect.objectContaining({
        severity: "error",
        code: "test.single",
        count: 1,
      }),
    );
    expect(payload.groups[1]).toEqual(
      expect.objectContaining({
        severity: "warning",
        code: "test.repeated",
        count: 2,
      }),
    );
    expect(payload.groups[1]?.first_source_refs).toContain("wiki/seed.md");
  });

  test("diagnostics filters by severity, code, and processor", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.keep",
          message: "Keep this diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/new.md" }),
          ],
        }),
        processorId: "test.keep",
        proposalId: "prop_cli_filters",
        adoptedCommit: commitOid(f.headSha),
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "error",
          code: "test.drop",
          message: "Drop this diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/seed.md" }),
          ],
        }),
        processorId: "test.drop",
        proposalId: "prop_cli_filters",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        severity: "warning",
        code: "test.keep",
        processor: "test.keep",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly severity: string;
      readonly code: string;
      readonly message: string;
    }>;
    expect(rows).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "test.keep",
        message: "Keep this diagnostic",
      }),
    ]);
  });

  test("subjects 'questions' and 'outbox' both return 0", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect(
        { subject: "questions", vault: f.vaultPath },
      ),
    ).toBe(0);
    expect(
      await runInspect(
        { subject: "outbox", vault: f.vaultPath },
      ),
    ).toBe(0);
  });

  test("subject 'questions' exposes producer and source provenance", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      const adopted = commitOid(f.headSha);
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Resolve this source-backed uncertainty?",
          sourceRefs: [
            sourceRef({
              commit: adopted,
              path: "wiki/new.md",
              range: { startLine: 1, endLine: 1 },
            }),
          ],
          idempotencyKey: "inspect-question-provenance",
          metadata: {
            risk: "low",
            confidence: 0.9,
            automationPolicy: "agent-safe",
          },
        }),
        processorId: "test.question",
        runId: "run-cli-question",
        adoptedCommit: adopted,
      });
    } finally {
      projection.value.db.close();
    }

    captured.out = [];
    expect(
      await runInspect({
        subject: "questions",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly question: string;
      readonly processor: string;
      readonly run: string;
      readonly adopted: string;
      readonly source_refs: string;
    }>;
    expect(rows[0]).toEqual(
      expect.objectContaining({
        question: "Resolve this source-backed uncertainty?",
        processor: "test.question",
        run: "run-cli-question",
        adopted: f.headSha,
      }),
    );
    expect(rows[0]?.source_refs).toContain("wiki/new.md:1");
  });

  test("subject 'questions' --json exposes the answered_by audit field", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      const adopted = commitOid(f.headSha);
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Auto-resolved question?",
          sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
          idempotencyKey: "inspect-question-answered-by",
        }),
        processorId: "test.question",
        runId: "run-cli-question",
        adoptedCommit: adopted,
      });
      applyQuestionAnswer(projection.value.db, {
        idempotencyKey: "inspect-question-answered-by",
        answer: "track",
        answeredAt: new Date().toISOString(),
        answeredBy: "auto",
      });
    } finally {
      projection.value.db.close();
    }

    captured.out = [];
    expect(
      await runInspect({
        subject: "questions",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly answered_by: string;
    }>;
    expect(rows[0]?.answered_by).toBe("auto");
  });

  test("corrupt operational JSON returns a clear state-read failure", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect(
        { subject: "outbox", vault: f.vaultPath },
      ),
    ).toBe(0);
    const db = new Database(join(f.vaultPath, ".dome", "state", "outbox.db"));
    try {
      const now = new Date().toISOString();
      db.query(
        "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, next_attempt_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "calendar.write",
        "bad-json",
        "{not-json",
        "[]",
        "pending",
        0,
        3,
        now,
        now,
        "run_bad_json",
      );
    } finally {
      db.close();
    }

    const code = await runInspect(
      { subject: "outbox", vault: f.vaultPath },
    );
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("state read failed");
    expect(captured.err.join("\n")).toContain(
      "operational database may be corrupt",
    );
  });

  test("missing positional subject returns 64 (EX_USAGE)", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runInspect({ vault: f.vaultPath })).toBe(64);
  });

  test("unknown subject returns 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({ subject: "garbage", vault: f.vaultPath }),
    ).toBe(64);
  });

  test("malformed --limit returns 64 before opening runtime", async () => {
    expect(await runInspect({ subject: "runs", limit: "10x" })).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--limit must be a positive integer",
    );
  });

  test("diagnostic-only flags reject other subjects", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        summary: true,
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "only valid for the diagnostics subject",
    );

    captured.err = [];
    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        processor: "dome.markdown.normalize-frontmatter",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--processor is only valid for the diagnostics and patches subjects",
    );
  });

  test("fact-only flags reject other subjects", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        predicate: "dome.graph.links_to",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "only valid for the facts subject",
    );
  });

  test("invalid fact filters return 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        subjectKind: "file",
        subjectId: "wiki/seed.md",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--subject-kind must be one of page, task, entity",
    );

    captured.err = [];
    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        subjectKind: "page",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--subject-kind and --subject-id must be provided together",
    );
  });

  test("invalid diagnostic severity returns 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        severity: "fatal",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--severity must be one of info, warning, error, block",
    );
  });

  test("empty inspect subject collapses to a single verdict line", async () => {
    // 'questions' on a fresh vault always has no rows.
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runInspect({ subject: "questions", vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");
    const nonBlank = out.split("\n").filter((l) => l.trim().length > 0);
    expect(nonBlank.length).toBe(1);
    expect(out).toContain("no rows");
    // The old multi-line "(no rows)" table row must NOT appear.
    expect(out).not.toContain("(no rows)");
    // No hidden-fields footnote on an empty result.
    expect(out).not.toContain("--json");
  });

  test("table column headers are lowercase for populated results", async () => {
    // 'bundles' and 'processors' always have rows (SDK ships first-party bundles).
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runInspect({ subject: "processors", vault: f.vaultPath })).toBe(0);
    const processorsOut = captured.out.join("\n");
    // Headers must be lowercase.
    expect(processorsOut).toContain("processor");
    expect(processorsOut).not.toContain("PROCESSOR");
    expect(processorsOut).toContain("phase");
    expect(processorsOut).not.toContain("PHASE");

    captured.out = [];
    expect(await runInspect({ subject: "runs", vault: f.vaultPath })).toBe(0);
    // runs is empty on a fresh vault → single-line verdict; no header row.
    // The column-header test uses 'processors' (always non-empty) above.
  });
});

// ----- runInspect cost --------------------------------------------------------
//
// `dome inspect cost [--days N]` — spend observability over the run
// ledger's `cost_usd` column. Read-only posture (mirrors `dome log`):
// a vault without runs.db gets a clean zero table, and the command never
// scaffolds the ledger file it only reads.

type CostJsonReport = {
  readonly schema: string;
  readonly days: number;
  readonly since: string;
  readonly processors: ReadonlyArray<{
    readonly processor: string;
    readonly extension: string;
    readonly runs: number;
    readonly total_cost_usd: number;
    readonly today_cost_usd: number;
  }>;
  readonly extensions: ReadonlyArray<{
    readonly extension: string;
    readonly runs: number;
    readonly total_cost_usd: number;
    readonly today_cost_usd: number;
  }>;
  readonly total: {
    readonly runs: number;
    readonly total_cost_usd: number;
    readonly today_cost_usd: number;
  };
};

/** Seed one terminal run row with a controlled cost + start time. */
async function seedCostRun(
  f: Fixture,
  opts: {
    readonly processorId: string;
    readonly costUsd: number | null;
    readonly startedAt: Date;
  },
): Promise<void> {
  const ledger = await openLedgerDb({
    path: join(f.vaultPath, ".dome", "state", "runs.db"),
  });
  if (!ledger.ok) throw new Error(`ledger open failed: ${ledger.error.kind}`);
  try {
    const id = newRunId(opts.startedAt);
    insertQueued(ledger.value.db, {
      id,
      proposalId: null,
      processorId: opts.processorId,
      processorVersion: "0.0.1",
      phase: "garden",
      inputCommit: commitOid(f.headSha),
      triggerKind: "schedule",
      triggerPayload: null,
      startedAt: opts.startedAt,
    });
    markRunning(ledger.value.db, id, opts.startedAt);
    markSucceeded(ledger.value.db, {
      id,
      effectHashes: [],
      costUsd: opts.costUsd,
      durationMs: 10,
      outputCommit: null,
      finishedAt: opts.startedAt,
    });
  } finally {
    ledger.value.db.close();
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("runInspect cost", () => {
  test("missing ledger yields a clean zero table and is never scaffolded", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const ledgerPath = join(f.vaultPath, ".dome", "state", "runs.db");
    expect(existsSync(ledgerPath)).toBe(false);

    expect(await runInspect({ subject: "cost", vault: f.vaultPath })).toBe(0);
    const costOut = captured.out.join("\n");
    expect(costOut).toContain("no spend");
    // Empty cost: collapses to one non-blank line (no $0.0000 Total block).
    expect(costOut.split("\n").filter((l) => l.trim().length > 0).length).toBe(1);
    // Read-only posture: the read must not create runs.db.
    expect(existsSync(ledgerPath)).toBe(false);

    captured.out = [];
    expect(
      await runInspect({ subject: "cost", vault: f.vaultPath, json: true }),
    ).toBe(0);
    const report = JSON.parse(captured.out.join("\n")) as CostJsonReport;
    expect(report.schema).toBe(INSPECT_COST_SCHEMA);
    expect(report.days).toBe(7);
    expect(report.processors).toEqual([]);
    expect(report.extensions).toEqual([]);
    expect(report.total).toEqual({
      runs: 0,
      total_cost_usd: 0,
      today_cost_usd: 0,
    });
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test("aggregates per-processor rows, extension subtotals, and a grand total", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const now = new Date();
    const today = new Date(now.getTime() - 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

    await seedCostRun(f, {
      processorId: "dome.agent.ingest",
      costUsd: 0.25,
      startedAt: today,
    });
    await seedCostRun(f, {
      processorId: "dome.agent.ingest",
      costUsd: 0.5,
      startedAt: threeDaysAgo,
    });
    await seedCostRun(f, {
      processorId: "dome.claims.index",
      costUsd: 0.125,
      startedAt: today,
    });
    // Outside the default 7-day window.
    await seedCostRun(f, {
      processorId: "dome.agent.brief",
      costUsd: 4,
      startedAt: thirtyDaysAgo,
    });
    // Cost-free run: never shows up in the spend view.
    await seedCostRun(f, {
      processorId: "dome.graph.links",
      costUsd: null,
      startedAt: today,
    });

    expect(
      await runInspect({ subject: "cost", vault: f.vaultPath, json: true }),
    ).toBe(0);
    const report = JSON.parse(captured.out.join("\n")) as CostJsonReport;
    expect(report.schema).toBe(INSPECT_COST_SCHEMA);
    expect(report.days).toBe(7);
    // Ordered by total spend descending.
    expect(report.processors.map((row) => row.processor)).toEqual([
      "dome.agent.ingest",
      "dome.claims.index",
    ]);
    expect(report.processors[0]).toEqual(
      expect.objectContaining({
        processor: "dome.agent.ingest",
        extension: "dome.agent",
        runs: 2,
        total_cost_usd: 0.75,
        today_cost_usd: 0.25,
      }),
    );
    expect(report.processors[1]).toEqual(
      expect.objectContaining({
        processor: "dome.claims.index",
        extension: "dome.claims",
        runs: 1,
        total_cost_usd: 0.125,
        today_cost_usd: 0.125,
      }),
    );
    expect(report.extensions).toEqual([
      expect.objectContaining({
        extension: "dome.agent",
        runs: 2,
        total_cost_usd: 0.75,
        today_cost_usd: 0.25,
      }),
      expect.objectContaining({
        extension: "dome.claims",
        runs: 1,
        total_cost_usd: 0.125,
        today_cost_usd: 0.125,
      }),
    ]);
    expect(report.total).toEqual({
      runs: 3,
      total_cost_usd: 0.875,
      today_cost_usd: 0.375,
    });

    // Widening the window picks up the older brief run.
    captured.out = [];
    expect(
      await runInspect({
        subject: "cost",
        vault: f.vaultPath,
        days: 60,
        json: true,
      }),
    ).toBe(0);
    const wide = JSON.parse(captured.out.join("\n")) as CostJsonReport;
    expect(wide.days).toBe(60);
    expect(wide.processors[0]).toEqual(
      expect.objectContaining({
        processor: "dome.agent.brief",
        total_cost_usd: 4,
        today_cost_usd: 0,
      }),
    );
    expect(wide.total.total_cost_usd).toBeCloseTo(4.875, 10);
    expect(wide.total.runs).toBe(4);
  });

  test("renders a human table with subtotals and total", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await seedCostRun(f, {
      processorId: "dome.agent.ingest",
      costUsd: 0.25,
      startedAt: new Date(),
    });

    expect(await runInspect({ subject: "cost", vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("dome.agent.ingest");
    expect(out).toContain("$0.2500");
    expect(out).toContain("EXTENSIONS");
    expect(out).toContain("dome.agent");
    expect(out).toContain("TOTAL");
  });

  test("cost no-spend collapses to a single verdict line (no Total block)", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // No ledger seeded — zero spend.
    expect(await runInspect({ subject: "cost", vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");
    const nonBlank = out.split("\n").filter((l) => l.trim().length > 0);
    expect(nonBlank.length).toBe(1);
    expect(out).toContain("no spend");
    // The old $0.0000 Total block must NOT appear.
    expect(out).not.toContain("$0.0000");
    // No (no rows) table row.
    expect(out).not.toContain("(no rows)");
  });

  test("--days validation: malformed value and non-cost subjects return 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({ subject: "cost", vault: f.vaultPath, days: "7x" }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--days must be a positive integer",
    );

    captured.err = [];
    expect(
      await runInspect({ subject: "runs", vault: f.vaultPath, days: 7 }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--days is only valid for the cost subject",
    );
  });
});

describe("effectHashCount", () => {
  test("no truncation sentinel: returns the plain stored length", () => {
    expect(effectHashCount(["a", "b", "c"])).toBe(3);
    expect(effectHashCount([])).toBe(0);
  });

  test("with a truncation sentinel: returns stored hashes + dropped count", () => {
    const hashes = [...Array.from({ length: 100 }, () => "a"), "…+724 more effect hashes"];
    expect(effectHashCount(hashes)).toBe(824);
  });

  test("malformed sentinel-ish last element falls back to the plain length", () => {
    expect(effectHashCount(["a", "b", "…+x more effect hashes"])).toBe(3);
  });
});
