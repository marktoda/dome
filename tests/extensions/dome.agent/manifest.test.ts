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
  DEFAULT_SOURCE_KINDS,
  defaultSourceSubscription,
  FIRST_PARTY_EXTENSION_DEFAULTS,
} from "../../../src/cli/default-vault-config";
import type { Capability } from "../../../src/core/processor";
import { readablePath } from "../../../src/engine/core/path-capabilities";
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
      "meta/consolidation-ledger.md",
    );
    expect(patch?.kind === "patch.auto" ? patch.paths : []).toContain(
      "meta/consolidation-ledger.md",
    );
  });

  test("brief runs daily at 05:30 and re-composes on late source day-files", async () => {
    const manifest = await loadManifest();
    const brief = manifest.processors.find((p) => p.id === "dome.agent.brief");
    expect(brief).toBeDefined();
    expect(brief?.phase).toBe("garden");
    // The 05:30 cron composes the morning; the file.created signals on the
    // source day-files are the wake-tick choreography triggers (a wake-tick
    // burst can compose the brief before the async calendar/slack fetch
    // lands — the signal lets the brief's deterministic gate re-compose
    // exactly once per late-landing source kind).
    expect(brief?.triggers).toEqual([
      { kind: "schedule", cron: "30 5 * * *" },
      {
        kind: "signal",
        name: "file.created",
        pathPattern: "sources/calendar/*.md",
      },
      {
        kind: "signal",
        name: "file.created",
        pathPattern: "sources/slack/*.md",
      },
    ]);
    expect(brief?.execution?.class).toBe("llm");
    expect(brief?.module).toBe("processors/brief.ts");
  });

  test("ingest has an hourly schedule trigger (level-triggered backstop) plus its inbox signals", async () => {
    const manifest = await loadManifest();
    const ingest = manifest.processors.find(
      (p) => p.id === "dome.agent.ingest",
    );
    expect(ingest).toBeDefined();
    const schedule = (ingest?.triggers ?? []).filter(
      (t) => t.kind === "schedule",
    );
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.kind === "schedule" ? schedule[0].cron : undefined).toBe(
      "0 * * * *",
    );
    expect(
      (ingest?.triggers ?? []).some(
        (t) => t.kind === "signal" && t.pathPattern === "inbox/raw/*.md",
      ),
    ).toBe(true);
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
    // Two answer triggers, one writer: promotion and demotion questions are
    // both emitted by dome.agent.preference-promotion, and the SAME gated
    // handler answers both key families — no third core.md writer.
    expect(handler?.triggers).toEqual([
      {
        kind: "answer",
        questionProcessorId: "dome.agent.preference-promotion",
        idempotencyKeyPrefix: "dome.agent.preference-promotion:",
      },
      {
        kind: "answer",
        questionProcessorId: "dome.agent.preference-promotion",
        idempotencyKeyPrefix: "dome.agent.preference-demotion:",
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
    expect(readPaths).toContain("sources/slack/*.md");
    // The questions batch is scope-filtered by this grant: ingest's askOwner
    // questions ref inbox/raw/*.md and consolidate's ref the ledger, so both
    // must be readable or the brief silently drops agent-raised questions.
    expect(readPaths).toContain("inbox/**/*.md");
    expect(readPaths).toContain("meta/consolidation-ledger.md");
    const patch = brief?.capabilities.find((c) => c.kind === "patch.auto");
    expect(patch?.kind === "patch.auto" ? [...patch.paths].sort() : []).toEqual(
      // The signals page rides along for validated signal-line appends only
      // (the splice guard enforces the append shape in processor code).
      ["notes/*.md", "preferences/signals.md", "wiki/dailies/*.md"],
    );
  });

  test("every shipped source kind's day-file is readable by the brief through declared ∩ granted", async () => {
    // Grant/manifest lockstep, exercised through the REAL runtime gate:
    // scopeSnapshotForProcessor admits a path only when `readablePath` finds
    // it in the manifest capability ∩ the vault grant, and a miss returns
    // null SILENTLY — the brief just never sees the feed, with no diagnostic.
    // Declaring a source in the manifest alone (or granting it alone) is
    // invisible in unit tests that hand the processor a pre-scoped snapshot,
    // which is exactly how the slack feed shipped unreadable. Deriving the
    // day-file from each subscription's output_path makes this fail for the
    // next sources kind too, until BOTH lists name it.
    const manifest = await loadManifest();
    const declared =
      manifest.processors.find((p) => p.id === "dome.agent.brief")
        ?.capabilities ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const defaultRead = FIRST_PARTY_EXTENSION_DEFAULTS.find(
      (entry) => entry.id === "dome.agent",
    )?.grant.read;
    expect(Array.isArray(defaultRead)).toBe(true);
    const granted: ReadonlyArray<Capability> = [
      { kind: "read", paths: defaultRead as ReadonlyArray<string> },
    ];

    expect(DEFAULT_SOURCE_KINDS).toEqual(["calendar", "slack"]);
    for (const kind of DEFAULT_SOURCE_KINDS) {
      const outputPath = defaultSourceSubscription(kind).output_path;
      expect(typeof outputPath, `${kind} subscription must declare output_path`).toBe("string");
      const dayFile = String(outputPath).replace("{date}", "2026-06-12");
      expect(
        readablePath(dayFile, declared, granted),
        `${dayFile} must be readable by dome.agent.brief: add sources/${kind}/*.md to BOTH the manifest read capability and the dome.agent default grant read list`,
      ).not.toBeNull();
    }
    // Pin the two concrete paths the review found broken, independent of the
    // output_path derivation above.
    for (const path of [
      "sources/calendar/2026-06-12.md",
      "sources/slack/2026-06-12.md",
    ]) {
      expect(readablePath(path, declared, granted)).not.toBeNull();
    }
  });
});
