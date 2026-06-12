// Cadence + capability inventory for the dome.agent manifest. The wedge
// phase-4 contract: consolidate is NIGHTLY (recent-drift janitor), the brief
// fires before dome.daily.create-daily's 06:00 tick, and the brief's write
// grant is bounded to the daily-note targets.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  parseManifest,
  type Manifest,
} from "../../../src/extensions/manifest-schema";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const MANIFEST_PATH = join(
  REPO_ROOT,
  "assets",
  "extensions",
  "dome.agent",
  "manifest.yaml",
);

async function loadManifest(): Promise<Manifest> {
  const parsed = parseManifest(
    parseYaml(await readFile(MANIFEST_PATH, "utf8")),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.kind);
  return parsed.value;
}

describe("dome.agent manifest cadence + grants", () => {
  test("consolidate runs nightly at 02:00 (schedule trigger only)", async () => {
    const manifest = await loadManifest();
    const consolidate = manifest.processors.find(
      (p) => p.id === "dome.agent.consolidate",
    );
    expect(consolidate).toBeDefined();
    expect(consolidate?.triggers).toEqual([
      { kind: "schedule", cron: "0 2 * * *" },
    ]);
  });

  test("consolidate declares the default ledger path in read + patch.auto", async () => {
    const manifest = await loadManifest();
    const consolidate = manifest.processors.find(
      (p) => p.id === "dome.agent.consolidate",
    );
    const read = consolidate?.capabilities.find((c) => c.kind === "read");
    const patch = consolidate?.capabilities.find(
      (c) => c.kind === "patch.auto",
    );
    expect(read?.kind === "read" ? read.paths : []).toContain(
      "consolidation-ledger.md",
    );
    expect(patch?.kind === "patch.auto" ? patch.paths : []).toContain(
      "consolidation-ledger.md",
    );
  });

  test("brief runs daily at 05:30, before create-daily's 06:00 tick", async () => {
    const manifest = await loadManifest();
    const brief = manifest.processors.find((p) => p.id === "dome.agent.brief");
    expect(brief).toBeDefined();
    expect(brief?.phase).toBe("garden");
    expect(brief?.triggers).toEqual([{ kind: "schedule", cron: "30 5 * * *" }]);
    expect(brief?.execution?.class).toBe("llm");
    expect(brief?.module).toBe("processors/brief.ts");
  });

  test("core.md is readable by every agent processor and auto-writable ONLY by the two gated block writers", async () => {
    const manifest = await loadManifest();
    const agents = ["dome.agent.ingest", "dome.agent.consolidate", "dome.agent.brief"];
    for (const id of agents) {
      const processor = manifest.processors.find((p) => p.id === id);
      const read = processor?.capabilities.find((c) => c.kind === "read");
      expect(
        read?.kind === "read" ? read.paths : [],
        `${id} must declare read over core.md`,
      ).toContain("core.md");
    }
    // The propose-only pin (decision 4 of the memory plan, evolved): core.md
    // appears in EXACTLY TWO patch.auto declarations in the whole bundle —
    // the answer-mediated preference-promotion handler (owner of the
    // promoted-preferences block) and the deterministic active-projects
    // renderer (owner of the active-projects block). Every core.md writer
    // owns a distinct generated block; everything else is propose-only
    // (wiki/specs/preferences.md §two-gated-writers).
    const coreWriters = manifest.processors.filter((processor) =>
      processor.capabilities.some(
        (capability) =>
          capability.kind === "patch.auto" &&
          capability.paths.includes("core.md"),
      ),
    );
    expect(coreWriters.map((p) => p.id).sort()).toEqual([
      "dome.agent.active-projects",
      "dome.agent.preference-promotion-answer",
    ]);
  });

  test("active-projects is deterministic, narrow, and scheduled between the index render and the brief", async () => {
    const manifest = await loadManifest();
    const processor = manifest.processors.find(
      (p) => p.id === "dome.agent.active-projects",
    );
    expect(processor).toBeDefined();
    expect(processor?.phase).toBe("garden");
    expect(processor?.execution?.class).toBe("deterministic");
    expect(processor?.module).toBe("processors/active-projects.ts");
    expect(processor?.triggers).toEqual([
      { kind: "schedule", cron: "20 5 * * *" },
      {
        kind: "signal",
        name: "document.changed",
        pathPattern: "wiki/dailies/*.md",
      },
    ]);
    const kinds = (processor?.capabilities ?? []).map((c) => c.kind).sort();
    expect(kinds).toEqual(["patch.auto", "read"]);
    const read = processor?.capabilities.find((c) => c.kind === "read");
    expect(read?.kind === "read" ? [...read.paths].sort() : []).toEqual([
      "core.md",
      "wiki/dailies/*.md",
    ]);
    const patch = processor?.capabilities.find((c) => c.kind === "patch.auto");
    expect(patch?.kind === "patch.auto" ? patch.paths : []).toEqual([
      "core.md",
    ]);
  });

  test("the promotion answer handler is narrow: exactly the core + signals pages", async () => {
    const manifest = await loadManifest();
    const handler = manifest.processors.find(
      (p) => p.id === "dome.agent.preference-promotion-answer",
    );
    expect(handler).toBeDefined();
    expect(handler?.triggers).toEqual([
      {
        kind: "answer",
        questionProcessorId: "dome.agent.preference-promotion",
        idempotencyKeyPrefix: "dome.agent.preference-promotion:",
      },
    ]);
    const kinds = (handler?.capabilities ?? []).map((c) => c.kind).sort();
    expect(kinds).toEqual(["patch.auto", "read"]);
    for (const capability of handler?.capabilities ?? []) {
      if (capability.kind !== "patch.auto" && capability.kind !== "read") {
        continue;
      }
      expect([...capability.paths].sort()).toEqual([
        "core.md",
        "preferences/signals.md",
      ]);
    }
  });

  test("the preference counter is deterministic and graph.write-only (rebuild-eligible)", async () => {
    const manifest = await loadManifest();
    const counter = manifest.processors.find(
      (p) => p.id === "dome.agent.preference-signals",
    );
    expect(counter).toBeDefined();
    expect(counter?.execution?.class).toBe("deterministic");
    const kinds = (counter?.capabilities ?? []).map((c) => c.kind).sort();
    expect(kinds).toEqual(["graph.write", "read"]);
    const graphWrite = counter?.capabilities.find(
      (c) => c.kind === "graph.write",
    );
    expect(
      graphWrite?.kind === "graph.write" ? graphWrite.namespaces : [],
    ).toEqual(["dome.preference.*"]);
    expect(
      counter?.triggers.every((trigger) => trigger.kind === "signal"),
    ).toBe(true);
  });

  test("every agent declares the preference-signals page in read + patch.auto", async () => {
    const manifest = await loadManifest();
    const agents = ["dome.agent.ingest", "dome.agent.consolidate", "dome.agent.brief"];
    for (const id of agents) {
      const processor = manifest.processors.find((p) => p.id === id);
      for (const kind of ["read", "patch.auto"] as const) {
        const capability = processor?.capabilities.find(
          (c) => c.kind === kind,
        );
        expect(
          capability !== undefined && "paths" in capability
            ? capability.paths
            : [],
          `${id} must declare ${kind} over preferences/signals.md`,
        ).toContain("preferences/signals.md");
      }
    }
  });

  test("brief's write grant is bounded to the daily-note targets and reads the calendar source", async () => {
    const manifest = await loadManifest();
    const brief = manifest.processors.find((p) => p.id === "dome.agent.brief");
    const kinds = (brief?.capabilities ?? []).map((c) => c.kind);
    expect(kinds).toContain("model.invoke");
    expect(kinds).toContain("question.ask");
    expect(kinds).not.toContain("graph.write"); // MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS

    const read = brief?.capabilities.find((c) => c.kind === "read");
    const readPaths = read?.kind === "read" ? read.paths : [];
    expect(readPaths).toContain("sources/calendar/*.md");
    // The questions batch is scope-filtered by this grant: ingest's askOwner
    // questions ref inbox/raw/*.md and consolidate's ref the ledger, so both
    // must be readable or the brief silently drops agent-raised questions.
    expect(readPaths).toContain("inbox/**/*.md");
    expect(readPaths).toContain("consolidation-ledger.md");
    const patch = brief?.capabilities.find((c) => c.kind === "patch.auto");
    expect(patch?.kind === "patch.auto" ? [...patch.paths].sort() : []).toEqual(
      // The signals page rides along for validated signal-line appends only
      // (the splice guard enforces the append shape in processor code).
      ["notes/*.md", "preferences/signals.md", "wiki/dailies/*.md"],
    );
  });
});
