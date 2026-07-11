#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { searchDocumentEffect } from "../src/core/effect";
import { commitOid, sourceRef } from "../src/core/source-ref";
import { RECALL_V1_CORPUS } from "../src/eval/corpora/recall-v1";
import { compileGardenQuality, type CompileGardenQualityInput } from "../src/eval/garden-quality";
import { scoreRecallCorpus } from "../src/eval/recall-quality";
import { capabilityUsesByRun } from "../src/ledger/capability-uses";
import { openLedgerDb } from "../src/ledger/db";
import { queryRuns } from "../src/ledger/runs";
import { openProjectionDb } from "../src/projections/db";
import { applySearchDocumentEffect, searchDocuments } from "../src/projections/search";
import { openProposalsDb } from "../src/proposals/db";
import { listProposals } from "../src/proposals/pending-proposals";
import {
  RETRIEVAL_MISSES_PATH,
  summarizeRetrievalMissEvidence,
  type RetrievalMissEvidence,
} from "../src/surface/report-miss";
import { openVault } from "../src/vault";

const ADOPTED = commitOid("e".repeat(40));

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "dome-product-quality-"));
  try {
    const opened = await openProjectionDb({
      path: join(temp, "projection.db"),
      extensionSet: [], processorVersions: [], capabilityPolicyHash: "product-quality",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const db = opened.value.db;
    let recall;
    try {
      for (const document of RECALL_V1_CORPUS.documents) {
        applySearchDocumentEffect(db, {
          adoptedCommit: ADOPTED,
          effect: searchDocumentEffect({
            operation: "upsert", path: document.path, category: document.category,
            ...(document.type === undefined ? {} : { type: document.type }),
            title: document.title, body: document.body,
            sourceRefs: [sourceRef({ commit: ADOPTED, path: document.path })],
          }),
        });
      }
      recall = scoreRecallCorpus(RECALL_V1_CORPUS, (query, limit) =>
        searchDocuments(db, { query: query.question, limit })
      );
    } finally {
      db.close();
    }

    const vaultArg = argumentValue("--vault");
    const vaultEvidence = vaultArg === null
      ? null
      : await collectVaultEvidence(resolve(vaultArg));
    console.log(JSON.stringify({
      schema: "dome.eval.product-quality/v2",
      recall,
      garden: vaultEvidence?.garden ?? null,
      retrievalMissEvidence: vaultEvidence?.retrievalMissEvidence ?? null,
    }, null, 2));
    // Recall floors remain the only product-quality release gate. Garden and
    // retrieval evidence are observational and never change this exit code.
    process.exitCode = recall.passed ? 0 : 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function collectVaultEvidence(vaultPath: string): Promise<{
  readonly garden: ReturnType<typeof compileGardenQuality>;
  readonly retrievalMissEvidence: RetrievalMissEvidence;
}> {
  const publicVault = await openVault({ path: vaultPath });
  if (!publicVault.ok) {
    throw new Error(`product-quality vault open failed: ${JSON.stringify(publicVault.error)}`);
  }
  let currentOpportunityCount: number | null = null;
  let retrievalMissEvidence: RetrievalMissEvidence;
  try {
    const view = await publicVault.value.runView("garden");
    if (view.kind === "ok") {
      const data = view.structured?.data;
      if (isRecord(data) && typeof data.totalOpportunities === "number") {
        currentOpportunityCount = data.totalOpportunities;
      }
    }
    const missDocument = await publicVault.value.readDocument(RETRIEVAL_MISSES_PATH);
    retrievalMissEvidence = summarizeRetrievalMissEvidence(missDocument?.content ?? null);
  } finally {
    await publicVault.value.close();
  }

  const input: CompileGardenQualityInput = {
    proposals: await readGardenProposals(vaultPath),
    ...(await readGardenRuns(vaultPath)),
    currentOpportunityCount,
  };
  return Object.freeze({
    garden: compileGardenQuality(input),
    retrievalMissEvidence,
  });
}

async function readGardenProposals(vault: string) {
  const path = join(vault, ".dome", "state", "proposals.db");
  if (!existsSync(path)) return Object.freeze([]);
  const opened = await openProposalsDb({ path });
  if (!opened.ok) throw new Error(`garden proposals: ${JSON.stringify(opened.error)}`);
  try {
    return Object.freeze(
      listProposals(opened.value.db).filter((row) => row.processorId === "dome.agent.garden"),
    );
  } finally {
    opened.value.db.close();
  }
}

async function readGardenRuns(vault: string): Promise<Pick<
  CompileGardenQualityInput,
  "runs" | "capabilityUsesByRun"
>> {
  const path = join(vault, ".dome", "state", "runs.db");
  if (!existsSync(path)) {
    return { runs: Object.freeze([]), capabilityUsesByRun: Object.freeze([]) };
  }
  const opened = await openLedgerDb({ path });
  if (!opened.ok) throw new Error(`garden runs: ${JSON.stringify(opened.error)}`);
  try {
    const runs = queryRuns(opened.value.db, { processorId: "dome.agent.garden" });
    return Object.freeze({
      runs,
      capabilityUsesByRun: Object.freeze(runs.map((run) => Object.freeze({
        runId: String(run.id),
        uses: capabilityUsesByRun(opened.value.db, run.id),
      }))),
    });
  } finally {
    opened.value.db.close();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
