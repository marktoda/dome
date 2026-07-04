// scenarios/effect-kinds/stale-claims-via-dome-run.scenario.test.ts
//
// dome.claims.stale-claims (Phase C) is the claims-loop health instrument:
// a command-triggered view-phase processor invoked via `dome run stale-claims`.
// It reads `dome.claims.claim` facts from the projection, joins each claim's
// durable `asOf` date against the current clock, and emits a ViewEffect listing
// every claim older than the configured horizon (default 120 days). This
// scenario mirrors the orphan-pages view-effect-via-dome-run scenario:
//   - command-triggered view-phase processor invocation,
//   - the `dome run <name> --json` CLI surface,
//   - the `runCli` harness helper.
//
// Staleness is measured against ctx.now(); the `dome run` path opens its own
// runtime against the SYSTEM clock (the harness TestClock is not threaded into
// the CLI dispatch), so we make the stale claim far in the past (2020-01-01,
// always > 120 days stale) and the fresh claim a recent date computed from the
// real clock so the test stays robust as time passes.

import { expect } from "bun:test";

import { scenario } from "../../index";

const CONFIG = `
extensions:
  dome.claims:
    enabled: true
    grant:
      read: ["wiki/**/*.md", "notes/*.md"]
      patch.auto: ["wiki/**/*.md", "notes/*.md"]
      graph.write: ["dome.claims.*"]
`;

// A recent date (10 days before real now), well within the default 120-day
// horizon, so the fresh claim is never reported stale regardless of when the
// suite runs.
function recentIso(): string {
  const d = new Date(Date.now() - 10 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

scenario(
  {
    name:
      "effect-kinds: dome run stale-claims surfaces stale claims via ViewEffect",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: ["dome.claims"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a vault with one clearly-stale claim (asOf 2020-01-01)
    // and one fresh claim (asOf ~10 days ago). The inline `*(as of …)*` marker
    // is how the claim indexer extracts the durable `asOf`.
    const fresh = recentIso();
    await h.userCommit({
      files: {
        "wiki/stale.md": [
          "# Stale",
          "",
          "- **Status:** Shipped *(as of 2020-01-01)*",
          "",
        ].join("\n"),
        "wiki/fresh.md": [
          "# Fresh",
          "",
          `- **Status:** Active *(as of ${fresh})*`,
          "",
        ].join("\n"),
      },
      message: "vault with stale + fresh claims",
    });

    // Step 2: adopt — dome.claims.index emits a `dome.claims.claim` fact per
    // claim line (two total).
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim" })
      .toHaveCount(2);

    // Step 3: invoke `dome run stale-claims --json` via runCli.
    const cli = await h.runCli(["run", "stale-claims", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    // Step 4: parse the JSON output — a single ViewEffect render object.
    const payload = JSON.parse(cli.stdout) as {
      readonly name: string;
      readonly kind: "structured";
      readonly schema: string;
      readonly data: {
        readonly schema: string;
        readonly asOfCommit: string;
        readonly horizonDays: number;
        readonly staleClaims: ReadonlyArray<{
          readonly path: string;
          readonly key: string;
          readonly value: string;
          readonly asOf: string;
          readonly daysStale: number;
        }>;
      };
    };
    expect(payload.name).toBe("dome.claims.stale-claims");
    expect(payload.kind).toBe("structured");
    expect(payload.schema).toBe("dome.claims.stale-claims/v1");
    expect(payload.data.horizonDays).toBe(120);

    // Step 5: the stale page is reported; the fresh page is excluded.
    const stalePaths = payload.data.staleClaims.map((c) => c.path);
    expect(stalePaths).toContain("wiki/stale.md");
    expect(stalePaths).not.toContain("wiki/fresh.md");

    // Step 6: the reported stale row carries the decoded claim + asOf.
    const staleRow = payload.data.staleClaims.find(
      (c) => c.path === "wiki/stale.md",
    );
    expect(staleRow?.key).toBe("Status");
    expect(staleRow?.value).toBe("Shipped");
    expect(staleRow?.asOf).toBe("2020-01-01");
    expect(staleRow?.daysStale).toBeGreaterThan(120);
  },
);

// `dome stale-claims` (Task 14) is the dedicated top-level verb over the
// same `dome.claims.stale-claims` view processor — previously reachable
// only via the hidden `dome run stale-claims` dispatcher above. Unlike
// `dome run <name>` (always the `{name,kind,schema,data}` envelope), the
// dedicated verb renders a human summary by default and the bare
// structured payload under `--json`.
scenario(
  {
    name:
      "effect-kinds: dome stale-claims (dedicated verb) dispatches to dome.claims.stale-claims",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: ["dome.claims"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/stale.md": [
          "# Stale",
          "",
          "- **Status:** Shipped *(as of 2020-01-01)*",
          "",
        ].join("\n"),
      },
      message: "vault with one stale claim",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim" })
      .toHaveCount(1);

    const text = await h.runCli(["stale-claims"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("wiki/stale.md");
    expect(text.stdout).not.toMatch(/^\s*[{[]/); // not a JSON envelope

    const json = await h.runCli(["stale-claims", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    const payload = JSON.parse(json.stdout) as {
      readonly schema: string;
      readonly horizonDays: number;
      readonly staleClaims: ReadonlyArray<{ readonly path: string }>;
    };
    expect(payload.schema).toBe("dome.claims.stale-claims/v1");
    expect(payload.horizonDays).toBe(120);
    expect(payload.staleClaims.map((c) => c.path)).toContain("wiki/stale.md");
  },
);
