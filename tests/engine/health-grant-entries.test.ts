// First-party grant-entry probes (`capability.grant-entry-missing`).
//
// `dome init --refresh-config` fills only MISSING grant keys, so an existing
// vault that predates the memory-quality phases keeps its old grant lists:
// the kind is granted but the new entry is not — invisible to the kind-level
// `capability.grant-missing` probe. `dome doctor` must name the exact YAML
// to add (docs/memory.md §"Vault rollout"). These tests drive
// `capabilityGrantEntryFindings` directly with a stub registry.

import { describe, expect, test } from "bun:test";

import { capabilityGrantEntryFindings } from "../../src/engine/health";
import type { Capability } from "../../src/core/processor";
import type { ProcessorRegistry } from "../../src/processors/registry";

function read(...paths: string[]): Capability {
  return { kind: "read", paths } as Capability;
}
function patchAuto(...paths: string[]): Capability {
  return { kind: "patch.auto", paths } as Capability;
}
function graphWrite(...namespaces: string[]): Capability {
  return { kind: "graph.write", namespaces } as Capability;
}

// Declared capability sets mirroring the shipped manifests (only the
// path/namespace entries the probes care about).
const DECLARED: Readonly<Record<string, ReadonlyArray<Capability>>> = {
  "dome.daily.attention-discount": [
    read("wiki/**/*.md", "notes/*.md"),
    graphWrite("dome.attention.*"),
  ],
  "dome.agent.brief": [
    read(
      "wiki/**/*.md",
      "notes/**/*.md",
      "core.md",
      "preferences/signals.md",
    ),
    patchAuto("wiki/dailies/*.md", "notes/*.md", "preferences/signals.md"),
  ],
  "dome.agent.preference-signals": [
    read("preferences/signals.md", "core.md"),
    graphWrite("dome.preference.*"),
  ],
  "dome.agent.preference-promotion-answer": [
    read("core.md", "preferences/signals.md"),
    patchAuto("core.md", "preferences/signals.md"),
  ],
  "dome.markdown.core-size": [read("core.md")],
  "dome.markdown.page-status": [
    read("**/*.md"),
    graphWrite("dome.page.*"),
  ],
};

function stubRegistry(
  processorIds: ReadonlyArray<string>,
): ProcessorRegistry {
  return {
    get: (id: string) =>
      processorIds.includes(id) && DECLARED[id] !== undefined
        ? ({ id, capabilities: DECLARED[id] } as never)
        : undefined,
    all: () => [],
  } as unknown as ProcessorRegistry;
}

function findingsFor(opts: {
  readonly processorIds: ReadonlyArray<string>;
  readonly grants: Readonly<Record<string, ReadonlyArray<Capability>>>;
}) {
  return capabilityGrantEntryFindings({
    registry: stubRegistry(opts.processorIds),
    resolveGrants: (processorId) => opts.grants[processorId] ?? [],
  });
}

const ALL_IDS = Object.keys(DECLARED);

// The pre-rollout grant shape: every kind present, none of the new entries.
const PRE_ROLLOUT_DAILY = [
  read("wiki/**/*.md", "notes/*.md"),
  patchAuto("wiki/**/*.md", "notes/*.md"),
  graphWrite("dome.daily.*"),
];
const PRE_ROLLOUT_AGENT = [
  read("wiki/**/*.md", "notes/**/*.md", "inbox/**/*.md", "index.md", "log.md"),
  patchAuto("wiki/**/*.md", "notes/**/*.md", "index.md", "log.md"),
  graphWrite("dome.graph.*"),
];
const PRE_ROLLOUT_MARKDOWN = [
  read("wiki/**/*.md", ".dome/page-types.yaml"),
  patchAuto("wiki/**/*.md"),
  graphWrite("dome.graph.*"),
];

describe("capabilityGrantEntryFindings", () => {
  test("a pre-rollout vault gets one loud finding per missing requirement", () => {
    const findings = findingsFor({
      processorIds: ALL_IDS,
      grants: {
        "dome.daily.attention-discount": PRE_ROLLOUT_DAILY,
        "dome.agent.brief": PRE_ROLLOUT_AGENT,
        "dome.agent.preference-signals": PRE_ROLLOUT_AGENT,
        "dome.agent.preference-promotion-answer": PRE_ROLLOUT_AGENT,
        "dome.markdown.core-size": PRE_ROLLOUT_MARKDOWN,
        "dome.markdown.page-status": PRE_ROLLOUT_MARKDOWN,
      },
    });
    expect(findings.map((f) => f.code)).toEqual(
      findings.map(() => "capability.grant-entry-missing"),
    );
    expect(findings.every((f) => f.severity === "warning")).toBe(true);

    const byProcessor = new Map(
      findings.map((f) => [
        f.id,
        f.code === "capability.grant-entry-missing" ? f : null,
      ]),
    );
    expect([...byProcessor.keys()].sort()).toEqual([
      "dome.agent.brief|read:core.md",
      "dome.agent.brief|read:preferences/signals.md|patch.auto:preferences/signals.md",
      "dome.agent.preference-promotion-answer|read:core.md|read:preferences/signals.md|patch.auto:core.md|patch.auto:preferences/signals.md",
      "dome.agent.preference-signals|graph.write:dome.preference.topic",
      "dome.daily.attention-discount|graph.write:dome.attention.discount",
      "dome.markdown.core-size|read:core.md",
      "dome.markdown.page-status|graph.write:dome.page.status",
    ]);

    // Each recovery names the exact YAML to add.
    const attention = findings.find((f) =>
      f.id.startsWith("dome.daily.attention-discount"),
    );
    expect(attention?.recovery).toContain('"dome.attention.*"');
    expect(attention?.recovery).toContain(
      "extensions.dome.daily.grant.graph.write",
    );
    const answer = findings.find((f) =>
      f.id.startsWith("dome.agent.preference-promotion-answer"),
    );
    expect(answer?.recovery).toContain(
      "extensions.dome.agent.processors",
    );
    expect(answer?.recovery).toContain('"core.md", "preferences/signals.md"');
    const coreSize = findings.find((f) =>
      f.id.startsWith("dome.markdown.core-size"),
    );
    expect(coreSize?.recovery).toContain(
      "extensions.dome.markdown.grant.read",
    );
  });

  test("the rolled-out grant shape yields no findings", () => {
    const rolledOutAgent = [
      read(
        "wiki/**/*.md",
        "notes/**/*.md",
        "core.md",
        "preferences/signals.md",
      ),
      patchAuto("wiki/**/*.md", "notes/**/*.md", "preferences/signals.md"),
      graphWrite("dome.preference.*"),
    ];
    expect(
      findingsFor({
        processorIds: ALL_IDS,
        grants: {
          "dome.daily.attention-discount": [
            ...PRE_ROLLOUT_DAILY,
            graphWrite("dome.attention.*"),
          ],
          "dome.agent.brief": rolledOutAgent,
          "dome.agent.preference-signals": rolledOutAgent,
          "dome.agent.preference-promotion-answer": [
            read("core.md", "preferences/signals.md"),
            patchAuto("core.md", "preferences/signals.md"),
          ],
          "dome.markdown.core-size": [
            read("**/*.md", "core.md"),
            graphWrite("dome.page.*"),
          ],
          "dome.markdown.page-status": [
            read("**/*.md", "core.md"),
            graphWrite("dome.page.*"),
          ],
        },
      }),
    ).toEqual([]);
  });

  test("a wholly missing kind is the kind-level probe's job — no entry finding", () => {
    // dome.agent grant with NO graph.write at all: the counter's entry probe
    // stays quiet (capability.grant-missing already fires for the kind).
    const findings = findingsFor({
      processorIds: ["dome.agent.preference-signals"],
      grants: {
        "dome.agent.preference-signals": [
          read("preferences/signals.md", "core.md"),
        ],
      },
    });
    expect(findings).toEqual([]);
  });

  test("disabled bundles (processor not in registry) are skipped", () => {
    expect(
      findingsFor({ processorIds: [], grants: {} }),
    ).toEqual([]);
  });

  test("a broad glob satisfies the entry — no false positive", () => {
    // "**/*.md" covers core.md under the broker's matcher; the probe must
    // share that matcher and stay quiet.
    expect(
      findingsFor({
        processorIds: ["dome.markdown.core-size"],
        grants: {
          "dome.markdown.core-size": [read("**/*.md")],
        },
      }),
    ).toEqual([]);
  });
});
