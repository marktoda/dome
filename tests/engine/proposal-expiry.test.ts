// tests/engine/proposal-expiry: subject-liveness expiry for PENDING garden
// proposals whose owning processor is retired.
//
// Mirrors tests/engine/question-expiry.test.ts's scaffolding and the same
// disabled-bundle prefix escape (see docs/superpowers/plans/
// 2026-07-06-stock-gardening-phase1.md Task 2 + Global Constraints, and
// `isRetired` in src/engine/host/vault-runtime.ts, main commit 28b912d3
// "registry is authoritative for enabled bundles"):
//   (a) pending proposal from a retired processor -> rejected/expired +
//       diagnostic
//   (b) disabled-but-configured extension's proposal survives, then expires
//       once the bundle is fully removed from config
//   (c) applied/rejected rows are untouched (already-decided, no re-expiry)
//   (d) idempotent: a second pump run expires nothing further
//   (e) both processor and disabled-escape active -> untouched

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineProcessor } from "../../src/core/processor";
import { fileChange, type DiagnosticEffect } from "../../src/core/effect";
import { expireOrphanProposals } from "../../src/engine/operational/proposal-expiry";
import {
  decideProposal,
  enqueuePendingProposal,
  getProposal,
} from "../../src/proposals/pending-proposals";
import { openProposalsDb, type ProposalsDb } from "../../src/proposals/db";
import { buildRegistry, type ProcessorRegistry } from "../../src/processors/registry";

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

function activeProcessor(id: string): ReturnType<typeof defineProcessor> {
  return defineProcessor({
    id,
    version: "0.0.1",
    phase: "garden",
    triggers: [{ kind: "schedule", cron: "* * * * *" }],
    capabilities: [],
    run: async () => [],
  });
}

function registryWith(ids: ReadonlyArray<string>): ProcessorRegistry {
  const built = buildRegistry(ids.map(activeProcessor));
  if (!built.ok) throw new Error(`registry build failed: ${built.error.kind}`);
  return built.value;
}

async function openTestProposals(root: string): Promise<ProposalsDb> {
  const opened = await openProposalsDb({ path: join(root, "proposals.db") });
  if (!opened.ok) throw new Error(`proposals open failed: ${opened.error.kind}`);
  return opened.value.db;
}

function enqueue(
  db: ProposalsDb,
  opts: { readonly processorId: string; readonly path: string; readonly createdAt: string },
): number {
  const result = enqueuePendingProposal(db, {
    processorId: opts.processorId,
    extensionId: opts.processorId.split(".")[0] ?? opts.processorId,
    runId: "run_1",
    reason: "test proposal",
    changes: [fileChange({ kind: "write", path: opts.path, content: "hello" })],
    sourceRefs: [],
    baseCommit: "a".repeat(40),
    baseContents: { [opts.path]: null },
    createdAt: opts.createdAt,
  });
  if (result.id === null) throw new Error("enqueue failed to produce an id");
  return result.id;
}

describe("expireOrphanProposals", () => {
  test("expires a pending proposal whose processor is retired", async () => {
    const root = mkdtempSync(join(tmpdir(), "proposal-expiry-"));
    tmpRoots.push(root);
    const proposals = await openTestProposals(root);
    try {
      const id = enqueue(proposals, {
        processorId: "dome.warden.integrity",
        path: "wiki/a.md",
        createdAt: "2026-07-01T00:00:00.000Z",
      });

      const recorded: DiagnosticEffect[] = [];
      const now = () => new Date("2026-07-06T00:00:00.000Z");
      const result = await expireOrphanProposals({
        registry: registryWith(["dome.other.active"]),
        disabledExtensionIds: [],
        proposals,
        recordDiagnostic: async (input) => {
          recorded.push(input.effect);
        },
        now,
      });

      expect(result.expired).toBe(1);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe(
        "proposal.expired-subject-retired",
      );

      const row = getProposal(proposals, id);
      expect(row?.status).toBe("rejected");
      expect(row?.decidedBy).toBe("expired");
      expect(row?.note).toBe("processor retired");
      expect(row?.decidedAt).toBe(now().toISOString());

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.code).toBe("proposal.expired-subject-retired");
      expect(recorded[0]?.severity).toBe("info");
      expect(recorded[0]?.message).toContain("dome.warden.integrity");
      expect(recorded[0]?.message).toContain(String(id));
    } finally {
      proposals.close();
    }
  });

  test("leaves a pending proposal untouched when its processor is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "proposal-expiry-"));
    tmpRoots.push(root);
    const proposals = await openTestProposals(root);
    try {
      const id = enqueue(proposals, {
        processorId: "dome.active.subject",
        path: "wiki/a.md",
        createdAt: "2026-07-01T00:00:00.000Z",
      });

      const recorded: DiagnosticEffect[] = [];
      const result = await expireOrphanProposals({
        registry: registryWith(["dome.active.subject"]),
        disabledExtensionIds: [],
        proposals,
        recordDiagnostic: async (input) => {
          recorded.push(input.effect);
        },
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      });

      expect(result.expired).toBe(0);
      expect(recorded).toHaveLength(0);
      expect(getProposal(proposals, id)?.status).toBe("pending");
    } finally {
      proposals.close();
    }
  });

  test("applied/rejected rows are untouched by a retired processor", async () => {
    const root = mkdtempSync(join(tmpdir(), "proposal-expiry-"));
    tmpRoots.push(root);
    const proposals = await openTestProposals(root);
    try {
      const appliedId = enqueue(proposals, {
        processorId: "dome.warden.integrity",
        path: "wiki/applied.md",
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      const rejectedId = enqueue(proposals, {
        processorId: "dome.warden.integrity",
        path: "wiki/rejected.md",
        createdAt: "2026-07-01T00:00:01.000Z",
      });
      decideProposal(proposals, {
        id: appliedId,
        status: "applied",
        decidedBy: "owner",
        appliedCommit: "b".repeat(40),
        decidedAt: "2026-07-02T00:00:00.000Z",
      });
      decideProposal(proposals, {
        id: rejectedId,
        status: "rejected",
        decidedBy: "owner",
        decidedAt: "2026-07-02T00:00:00.000Z",
      });

      const result = await expireOrphanProposals({
        registry: registryWith(["dome.other.active"]),
        disabledExtensionIds: [],
        proposals,
        recordDiagnostic: async () => {},
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      });

      expect(result.expired).toBe(0);
      expect(getProposal(proposals, appliedId)?.status).toBe("applied");
      expect(getProposal(proposals, appliedId)?.decidedBy).toBe("owner");
      expect(getProposal(proposals, rejectedId)?.status).toBe("rejected");
      expect(getProposal(proposals, rejectedId)?.decidedBy).toBe("owner");
    } finally {
      proposals.close();
    }
  });

  test("is idempotent: a second pump run expires nothing further", async () => {
    const root = mkdtempSync(join(tmpdir(), "proposal-expiry-"));
    tmpRoots.push(root);
    const proposals = await openTestProposals(root);
    try {
      const id = enqueue(proposals, {
        processorId: "dome.warden.integrity",
        path: "wiki/a.md",
        createdAt: "2026-07-01T00:00:00.000Z",
      });

      const deps = {
        registry: registryWith(["dome.other.active"]),
        disabledExtensionIds: [],
        proposals,
        recordDiagnostic: async (_input: {
          readonly effect: DiagnosticEffect;
          readonly processorId: string;
          readonly proposalId: string | null;
        }) => {},
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      };

      const first = await expireOrphanProposals(deps);
      expect(first.expired).toBe(1);

      const second = await expireOrphanProposals(deps);
      expect(second.expired).toBe(0);

      expect(getProposal(proposals, id)?.status).toBe("rejected");
    } finally {
      proposals.close();
    }
  });

  test("a disabled-but-configured bundle's proposal survives; it expires once the bundle is removed from config", async () => {
    const root = mkdtempSync(join(tmpdir(), "proposal-expiry-"));
    tmpRoots.push(root);
    const proposals = await openTestProposals(root);
    try {
      const id = enqueue(proposals, {
        processorId: "dome.warden.integrity",
        path: "wiki/a.md",
        createdAt: "2026-07-01T00:00:00.000Z",
      });

      const recorded: DiagnosticEffect[] = [];
      const depsBase = {
        registry: registryWith(["dome.other.active"]),
        proposals,
        recordDiagnostic: async (input: {
          readonly effect: DiagnosticEffect;
          readonly processorId: string;
          readonly proposalId: string | null;
        }) => {
          recorded.push(input.effect);
        },
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      };

      // Bundle configured but disabled -> exempt, nothing expires.
      const whileDisabled = await expireOrphanProposals({
        ...depsBase,
        disabledExtensionIds: ["dome.warden"],
      });
      expect(whileDisabled.expired).toBe(0);
      expect(recorded).toHaveLength(0);
      expect(getProposal(proposals, id)?.status).toBe("pending");

      // Same proposal, bundle removed from config entirely -> retired, expires.
      const afterRemoval = await expireOrphanProposals({
        ...depsBase,
        disabledExtensionIds: [],
      });
      expect(afterRemoval.expired).toBe(1);
      expect(getProposal(proposals, id)?.status).toBe("rejected");
      expect(getProposal(proposals, id)?.decidedBy).toBe("expired");
    } finally {
      proposals.close();
    }
  });
});
