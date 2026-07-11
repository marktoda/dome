#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { searchDocumentEffect } from "../src/core/effect";
import { commitOid, sourceRef } from "../src/core/source-ref";
import { RECALL_V1_CORPUS } from "../src/eval/corpora/recall-v1";
import { compileGardenQuality } from "../src/eval/garden-quality";
import { scoreRecallCorpus } from "../src/eval/recall-quality";
import { openProjectionDb } from "../src/projections/db";
import { applySearchDocumentEffect, searchDocuments } from "../src/projections/search";
import { openProposalsDb } from "../src/proposals/db";
import { listProposals } from "../src/proposals/pending-proposals";

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
    const garden = vaultArg === null ? null : await gardenReport(resolve(vaultArg));
    console.log(JSON.stringify({ schema: "dome.eval.product-quality/v1", recall, garden }, null, 2));
    process.exitCode = recall.passed ? 0 : 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function gardenReport(vault: string) {
  const path = join(vault, ".dome", "state", "proposals.db");
  if (!existsSync(path)) return compileGardenQuality([]);
  const opened = await openProposalsDb({ path });
  if (!opened.ok) throw new Error(`garden report: ${JSON.stringify(opened.error)}`);
  try {
    return compileGardenQuality(listProposals(opened.value.db));
  } finally {
    opened.value.db.close();
  }
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
