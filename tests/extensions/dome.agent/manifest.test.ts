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
      ["notes/*.md", "wiki/dailies/*.md"],
    );
  });
});
