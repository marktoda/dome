import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import consolidate, {
  consolidationLedgerPath,
} from "../../../assets/extensions/dome.agent/processors/consolidate";
import type { ProcessorContext, ModelStepResult } from "../../../src/core/processor";
import {
  patchEffect,
  type DiagnosticEffect,
  type PatchEffect,
  type QuestionEffect,
} from "../../../src/core/effect";
import { applyEffect, noopSinks } from "../../../src/engine/core/apply-effect";
import { loadCapabilityPolicy } from "../../../src/engine/core/capability-policy";
import { flattenBundleProcessors, loadBundles } from "../../../src/extensions/loader";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import type { RunId } from "../../../src/engine/core/runner-contract";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

function makeCtx(opts: {
  files: Record<string, string>;
  extensionConfig?: Record<string, unknown>;
  stepFn?: (input: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    readonly model?: string;
  }) => Promise<ModelStepResult>;
}): ProcessorContext {
  const modelInvoke =
    opts.stepFn === undefined
      ? undefined
      : (Object.assign(async () => "", {
          structured: async () => ({}) as never,
          step: opts.stepFn,
        }) as never);
  return {
    snapshot: {
      commit: "c" as never,
      tree: "t" as never,
      readFile: async (p: string) => opts.files[p] ?? null,
      listMarkdownFiles: async () => Object.keys(opts.files),
      getFileInfo: async () => null,
    },
    changedPaths: [],
    proposal: null,
    runId: "run1",
    input: { kind: "schedule" },
    now: () => new Date("2026-06-09T04:00:00Z"),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: opts.extensionConfig ?? {},
    ...(modelInvoke !== undefined ? { modelInvoke } : {}),
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

describe("dome.agent.consolidate", () => {
  test("no-op when no model step is wired", async () => {
    expect(await consolidate.run(makeCtx({ files: { "index.md": "x" } }))).toEqual([]);
  });

  test("text-only provider fails loudly: the engine's throwing step lands as consolidate-failed", async () => {
    // The engine attaches a THROWING step when a provider exists without
    // tool-step support (tests/engine/model-step.test.ts pins that seam).
    const ctx = makeCtx({
      files: { "index.md": "x" },
      stepFn: async () => {
        throw new Error(
          "dome.agent.consolidate: the configured model provider does not support tool-step invocation; wire a step provider (dome.model-provider.step/v1) to run agent processors.",
        );
      },
    });
    const effects = await consolidate.run(ctx);
    expect(effects).toHaveLength(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.code).toBe("dome.agent.consolidate-failed");
    expect(diag.message).toContain("does not support tool-step");
  });

  test("merges a duplicate into one PatchEffect: canonical write + absorbed delete + link rewrite", async () => {
    const files = {
      "index.md": "## Concepts\n- [[wiki/concepts/a]] — A\n- [[wiki/concepts/b]] — B (dup)\n",
      "wiki/concepts/a.md": "# A\nfact-A",
      "wiki/concepts/b.md": "# B\nfact-B",
      "wiki/concepts/refs-b.md": "see [[wiki/concepts/b]]",
    };
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "writePage", input: { path: "wiki/concepts/a.md", content: "# A\nfact-A\nfact-B" } }] };
      if (turns === 1)
        return { toolCalls: [{ id: "2", name: "deletePage", input: { path: "wiki/concepts/b.md" } }] };
      if (turns === 2)
        return { toolCalls: [{ id: "3", name: "writePage", input: { path: "wiki/concepts/refs-b.md", content: "see [[wiki/concepts/a]]" } }] };
      return { text: "merged b into a" };
    };
    const effects = await consolidate.run(makeCtx({ files, stepFn }));
    const patches = effects.filter((e) => e.kind === "patch") as PatchEffect[];
    expect(patches.length).toBe(1);
    const byPath = new Map(patches[0]!.changes.map((c) => [String(c.path), c]));
    expect(byPath.get("wiki/concepts/a.md")?.kind).toBe("write");
    expect(byPath.get("wiki/concepts/b.md")?.kind).toBe("delete");
    expect(byPath.get("wiki/concepts/refs-b.md")?.kind).toBe("write");
    expect(patches[0]!.sourceRefs.length).toBeGreaterThan(0);
  });

  test("ambiguous case asks instead of merging", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "askOwner", input: { question: "Merge X ← Y? may be distinct" } }] };
      return { text: "asked" };
    };
    const effects = await consolidate.run(makeCtx({ files: { "index.md": "x" }, stepFn }));
    expect(effects.find((e) => e.kind === "patch")).toBeUndefined();
    const q = effects.find((e) => e.kind === "question") as QuestionEffect;
    expect(q.question).toContain("Merge X");
  });

  test("mid-run throw rolls back atomically: no patch, only a diagnostic", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "deletePage", input: { path: "wiki/concepts/b.md" } }] };
      throw new Error("provider died mid-merge");
    };
    const effects = await consolidate.run(
      makeCtx({ files: { "index.md": "x", "wiki/concepts/b.md": "B" }, stepFn }),
    );
    expect(effects.length).toBe(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.code).toBe("dome.agent.consolidate-failed");
    expect(diag.message).toContain("rolled back");
  });

  test("a run exceeding the per-run patch cap is rolled back with an overreach diagnostic", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns < 31) {
        return {
          toolCalls: [
            {
              id: String(turns),
              name: "writePage",
              input: { path: `wiki/concepts/p${turns}.md`, content: "x" },
            },
          ],
        };
      }
      return { text: "done" };
    };
    const effects = await consolidate.run(makeCtx({ files: { "index.md": "x" }, stepFn }));
    expect(effects.find((e) => e.kind === "patch")).toBeUndefined();
    const diag = effects.find((e) => e.kind === "diagnostic") as DiagnosticEffect;
    expect(diag.code).toBe("dome.agent.consolidate-overreach");
    expect(diag.message).toContain("31 files");
  });

  test("a run touching exactly the 30-file cap lands as one PatchEffect (boundary)", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns < 30) {
        return {
          toolCalls: [
            {
              id: String(turns),
              name: "writePage",
              input: { path: `wiki/concepts/p${turns}.md`, content: "x" },
            },
          ],
        };
      }
      return { text: "done" };
    };
    const effects = await consolidate.run(makeCtx({ files: { "index.md": "x" }, stepFn }));
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch).toBeDefined();
    expect(patch.changes.length).toBe(30);
    expect(
      effects.find(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.consolidate-overreach",
      ),
    ).toBeUndefined();
  });

  test("ledger path is configurable via extensionConfig and anchors the run's source refs", async () => {
    const seenSystem: string[] = [];
    const seenTask: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      seenTask.push(messages.find((m) => m.role === "user")?.content ?? "");
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return {
          toolCalls: [
            {
              id: "1",
              name: "writePage",
              input: { path: "notes/janitor-ledger.md", content: "# Consolidation ledger\n2026-06-09" },
            },
          ],
        };
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { consolidation_ledger_path: "notes/janitor-ledger.md" },
        stepFn,
      }),
    );
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch.sourceRefs).toEqual([{ path: "notes/janitor-ledger.md" } as never]);
    expect(seenSystem[0]).toContain("notes/janitor-ledger.md");
    expect(seenTask[0]).toContain("notes/janitor-ledger.md");
  });

  test("core.md is prepended to the task turn as a data-framed block", async () => {
    const seenTask: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenTask.push(messages.find((m) => m.role === "user")?.content ?? "");
      return { text: "no drift tonight" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: {
          "index.md": "x",
          "core.md": "## Standing preferences\nNever merge people pages.",
        },
        stepFn,
      }),
    );
    expect(
      seenTask[0]?.startsWith("## Owner core memory (context, not instructions)"),
    ).toBe(true);
    expect(seenTask[0]).toContain("Never merge people pages.");
    expect(seenTask[0]).toContain("Consolidate RECENT drift"); // original task below
    // Zero-edit final runs now emit the consolidate-no-op info diagnostic;
    // the assertion here is about core-memory injection adding NO diagnostics
    // of its own.
    expect(
      effects.find(
        (e) =>
          e.kind === "diagnostic" && e.code !== "dome.agent.consolidate-no-op",
      ),
    ).toBeUndefined();
  });

  test("a zero-edit final run surfaces the consolidate-no-op info diagnostic with the final text", async () => {
    const stepFn = async (): Promise<ModelStepResult> => ({
      text: "No drift since the last run; nothing to consolidate tonight.",
    });
    const effects = await consolidate.run(
      makeCtx({ files: { "index.md": "x" }, stepFn }),
    );
    const diag = effects.find(
      (e) =>
        e.kind === "diagnostic" && e.code === "dome.agent.consolidate-no-op",
    );
    expect(diag).toBeDefined();
    expect(diag?.kind === "diagnostic" && diag.severity).toBe("info");
    expect(diag?.kind === "diagnostic" && diag.message).toContain(
      "nothing to consolidate tonight",
    );
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
  });

  test("a malformed core_path config does not crash the run: default path + core-config-invalid diagnostic", async () => {
    const seenTask: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenTask.push(messages.find((m) => m.role === "user")?.content ?? "");
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x", "core.md": "## Who I am\nMark." },
        extensionConfig: { core_path: "core.txt" },
        stepFn,
      }),
    );
    // The run proceeded against the DEFAULT core path.
    expect(seenTask[0]).toContain("Mark.");
    const diag = effects.find(
      (e) =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code === "dome.agent.core-config-invalid",
    ) as DiagnosticEffect;
    expect(diag).toBeDefined();
    expect(diag.severity).toBe("warning");
    expect(diag.message).toContain(".md path");
  });

  test("consolidationLedgerPath validates config values and falls back instead of throwing", () => {
    expect(consolidationLedgerPath(undefined)).toEqual({
      path: "meta/consolidation-ledger.md",
      problem: null,
    });
    expect(consolidationLedgerPath({})).toEqual({
      path: "meta/consolidation-ledger.md",
      problem: null,
    });
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "notes/x.md" }),
    ).toEqual({ path: "notes/x.md", problem: null });

    // Malformed config degrades to the default with a diagnostic message —
    // a raw throw here would crash the nightly run.
    const cases: ReadonlyArray<[unknown, string]> = [
      [7, "must be a string"],
      ["ledger.txt", ".md path"],
      ["/abs/ledger.md", "relative vault markdown path"],
      ["../up/ledger.md", "relative vault markdown path"],
    ];
    for (const [value, fragment] of cases) {
      const resolved = consolidationLedgerPath({
        consolidation_ledger_path: value,
      });
      expect(resolved.path).toBe("meta/consolidation-ledger.md");
      expect(resolved.problem).toContain(fragment);
      expect(resolved.problem).toContain("falling back to meta/consolidation-ledger.md");
    }
  });

  test("consolidate_targets scopes the charter to the configured prefixes with no diagnostic", async () => {
    const seenSystem: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { consolidate_targets: ["wiki/entities/"] },
        stepFn,
      }),
    );
    expect(seenSystem[0]).toContain("wiki/entities/");
    expect(seenSystem[0]).toContain("ONLY pages under these prefixes");
    expect(seenSystem[0]).not.toContain("pages under: wiki/.");
    // Valid config → silent (no config-invalid diagnostic).
    expect(
      effects.some(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
      ),
    ).toBe(false);
  });

  test("absent consolidate_targets defaults to whole-wiki scope (wiki/) silently", async () => {
    const seenSystem: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({ files: { "index.md": "x" }, stepFn }),
    );
    expect(seenSystem[0]).toContain("pages under: wiki/.");
    expect(
      effects.some(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
      ),
    ).toBe(false);
  });

  test("malformed consolidate_targets degrades to the wiki/ default with a warning diagnostic", async () => {
    for (const malformed of [7, [], [""], ["/abs/"], ["a\\b/"], ["../up/"], "wiki/"]) {
      const seenSystem: string[] = [];
      const stepFn = async ({
        messages,
      }: {
        readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
      }): Promise<ModelStepResult> => {
        seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
        return { text: "done" };
      };
      const effects = await consolidate.run(
        makeCtx({
          files: { "index.md": "x" },
          extensionConfig: { consolidate_targets: malformed },
          stepFn,
        }),
      );
      // The run proceeded against the whole-wiki default scope.
      expect(seenSystem[0]).toContain("pages under: wiki/.");
      const diag = effects.find(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
      ) as DiagnosticEffect;
      expect(diag).toBeDefined();
      expect(diag.severity).toBe("warning");
      expect(diag.message).toContain("consolidate_targets");
      expect(diag.message).toContain("falling back");
    }
  });

  test("a consolidate_targets prefix outside the write grant degrades with a grant-naming warning", async () => {
    const seenSystem: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { consolidate_targets: ["notes/"] },
        stepFn,
      }),
    );
    expect(seenSystem[0]).toContain("pages under: wiki/.");
    const diag = effects.find(
      (e) =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
    ) as DiagnosticEffect;
    expect(diag).toBeDefined();
    expect(diag.message).toContain("notes/");
    expect(diag.message).toContain("write grant");
  });

  test("a malformed ledger-path config does not crash the run: default path + config diagnostic", async () => {
    const seenTask: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenTask.push(messages.find((m) => m.role === "user")?.content ?? "");
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return {
          toolCalls: [
            {
              id: "1",
              name: "writePage",
              input: { path: "meta/consolidation-ledger.md", content: "# Ledger\n2026-06-09" },
            },
          ],
        };
      return { text: "done" };
    };
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { consolidation_ledger_path: 7 },
        stepFn,
      }),
    );
    // The run proceeded against the DEFAULT ledger path.
    const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
    expect(patch).toBeDefined();
    expect(patch.sourceRefs).toEqual([{ path: "meta/consolidation-ledger.md" } as never]);
    expect(seenTask[0]).toContain("meta/consolidation-ledger.md");
    // The malformed config surfaced as a warning diagnostic.
    const diag = effects.find(
      (e) =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
    ) as DiagnosticEffect;
    expect(diag).toBeDefined();
    expect(diag.severity).toBe("warning");
    expect(diag.message).toContain("must be a string");
  });

  test("patrol queue: a queued page OUTSIDE the configured scope joins the charter targets", async () => {
    // The frozen-tail contract (Task 16): patrol queues stale pages regardless
    // of drift; even when consolidate_targets is narrowed, the queued page is
    // force-added to the run's scope through the SAME targets → charter path.
    const seenSystem: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      return { text: "done" };
    };
    const queue = [
      "# Patrol queue",
      "",
      "_review these_",
      "",
      "- [[wiki/concepts/orphaned-idea]] — last updated 2025-01-01, 12 lines",
      "",
    ].join("\n");
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x", "meta/patrol-queue.md": queue },
        extensionConfig: { consolidate_targets: ["wiki/entities/"] },
        stepFn,
      }),
    );
    // The queued concepts page lands in the charter scope even though the
    // configured scope was only wiki/entities/.
    expect(seenSystem[0]).toContain("wiki/concepts/orphaned-idea");
    expect(seenSystem[0]).toContain("wiki/entities/");
    // Valid config + queue → no config-invalid diagnostic.
    expect(
      effects.some(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.consolidate-config-invalid",
      ),
    ).toBe(false);
  });

  test("patrol queue: a missing queue file changes nothing (baseline no-op is preserved)", async () => {
    const stepFn = async (): Promise<ModelStepResult> => ({
      text: "No drift tonight.",
    });
    // No meta/patrol-queue.md present at all.
    const effects = await consolidate.run(
      makeCtx({ files: { "index.md": "x" }, stepFn }),
    );
    // Exactly the baseline no-op diagnostic, no crash, no extra effects.
    expect(effects).toHaveLength(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.code).toBe("dome.agent.consolidate-no-op");
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
  });

  test("patrol queue: an empty-state queue file adds no scope pages (quiet night)", async () => {
    const seenSystem: string[] = [];
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      seenSystem.push(messages.find((m) => m.role === "system")?.content ?? "");
      return { text: "done" };
    };
    const emptyQueue =
      "# Patrol queue\n\n_No pages are due for patrol — every scanned page has been groomed within the last 35 days._\n";
    await consolidate.run(
      makeCtx({
        files: { "index.md": "x", "meta/patrol-queue.md": emptyQueue },
        stepFn,
      }),
    );
    // Default scope, no queued pages spliced into it.
    expect(seenSystem[0]).toContain("pages under: wiki/.");
  });

  test("model_overrides.consolidate routes every step call", async () => {
    const seen: Array<string | undefined> = [];
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { model_overrides: { consolidate: "claude-haiku-4-5" } },
        stepFn: async (input) => {
          seen.push(input.model);
          return { text: "done" };
        },
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["claude-haiku-4-5"]));
    expect(
      effects.some(
        (e) =>
          e.kind === "diagnostic" &&
          (e as DiagnosticEffect).code === "dome.agent.model-config-invalid",
      ),
    ).toBe(false);
  });

  test("malformed model_overrides degrades to the provider default with a warning", async () => {
    const seen: Array<string | undefined> = [];
    const effects = await consolidate.run(
      makeCtx({
        files: { "index.md": "x" },
        extensionConfig: { model_overrides: "claude-haiku-4-5" },
        stepFn: async (input) => {
          seen.push(input.model);
          return { text: "done" };
        },
      }),
    );
    // Degrade, not crash: the run proceeds on the provider default model.
    expect(new Set(seen)).toEqual(new Set([undefined]));
    const diag = effects.find(
      (e) =>
        e.kind === "diagnostic" &&
        (e as DiagnosticEffect).code === "dome.agent.model-config-invalid",
    ) as DiagnosticEffect | undefined;
    expect(diag?.severity).toBe("warning");
    expect(diag?.message).toContain("model_overrides must be an object");
  });
});

// ----- Operation 4: proposeSplit through the real processor (stock-gardening
// phase 1, Task 6) -----------------------------------------------------------

describe("dome.agent.consolidate proposes a page split (operation 4)", () => {
  const HUB_PATH = "wiki/entities/danny.md";
  const ORIGINAL = [
    "---",
    "type: entity",
    "description: Danny — colleague and cross-team collaborator",
    "---",
    "# Danny",
    "",
    "## Promo push 2026",
    "Danny is leading the promo packet effort for the 2026 cycle.",
    "",
    "## Onboarding notes",
    "Danny onboarded in March and paired with the platform team.",
    "",
  ].join("\n");
  const HUB = [
    "---",
    "type: entity",
    "description: Danny — colleague and cross-team collaborator",
    "---",
    "# Danny",
    "",
    "## Split into",
    "- [[wiki/entities/danny-promo-2026]] — the 2026 promo packet push",
    "- [[wiki/entities/danny-onboarding]] — onboarding history",
    "",
  ].join("\n");
  const SUB_PROMO = [
    "---",
    "description: Danny's 2026 promo packet push",
    "---",
    "# Danny — promo push 2026",
    "## Promo push 2026",
    "Danny is leading the promo packet effort for the 2026 cycle.",
    "",
  ].join("\n");
  const SUB_ONBOARDING = [
    "---",
    "description: Danny's onboarding history",
    "---",
    "# Danny — onboarding",
    "## Onboarding notes",
    "Danny onboarded in March and paired with the platform team.",
    "",
  ].join("\n");

  test("a mocked run calling proposeSplit emits one propose PatchEffect (hub+subs) alongside the ledger auto patch", async () => {
    const files = {
      "index.md": "x",
      [HUB_PATH]: ORIGINAL,
    };
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0) {
        return {
          toolCalls: [
            {
              id: "1",
              name: "proposeSplit",
              input: {
                hubPath: HUB_PATH,
                hubContent: HUB,
                subPages: [
                  { path: "wiki/entities/danny-promo-2026.md", content: SUB_PROMO },
                  { path: "wiki/entities/danny-onboarding.md", content: SUB_ONBOARDING },
                ],
                reason: "dome.agent.consolidate: split danny.md into promo + onboarding",
              },
            },
          ],
        };
      }
      if (turns === 1) {
        return {
          toolCalls: [
            {
              id: "2",
              name: "writePage",
              input: {
                path: "meta/consolidation-ledger.md",
                content: "# Consolidation ledger\n2026-06-09 proposed split of danny.md",
              },
            },
          ],
        };
      }
      return { text: "proposed a split of danny.md; ledger updated" };
    };
    const effects = await consolidate.run(makeCtx({ files, stepFn }));
    const patches = effects.filter((e) => e.kind === "patch") as PatchEffect[];
    expect(patches).toHaveLength(2);
    const auto = patches.find((p) => p.mode === "auto");
    const propose = patches.find((p) => p.mode === "propose");
    expect(auto).toBeDefined();
    expect(propose).toBeDefined();
    if (auto === undefined || propose === undefined) return;
    expect(auto.changes.map((c) => String(c.path))).toEqual([
      "meta/consolidation-ledger.md",
    ]);
    expect(propose.changes.map((c) => String(c.path))).toEqual([
      HUB_PATH,
      "wiki/entities/danny-promo-2026.md",
      "wiki/entities/danny-onboarding.md",
    ]);
    expect(propose.reason).toBe(
      "dome.agent.consolidate: split danny.md into promo + onboarding",
    );
    // The split patch's sourceRef resolves to the HUB page being split (the
    // consolidate processor's `sourceRef` wiring in finishAgentRun), not the
    // ledger sourceRefs the auto patch carries.
    expect(propose.sourceRefs).toHaveLength(1);
    expect(String(propose.sourceRefs[0]?.path)).toBe(HUB_PATH);
    expect(auto.sourceRefs.every((r) => String(r.path) !== HUB_PATH)).toBe(true);
  });
});

// ----- Broker-level: the shipped manifest + default grant actually
// authorizes the split-proposal patch (stock-gardening phase 1, Task 6)
// -----------------------------------------------------------------------

describe("consolidate's split-proposal patch is authorized end-to-end by the shipped manifest + default grant", () => {
  test("the real manifest declares patch.propose and the standard-preset default grants it", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-consolidate-propose-"));
    try {
      mkdirSync(join(root, ".dome"), { recursive: true });
      writeFileSync(
        join(root, ".dome", "config.yaml"),
        "grants: standard\nextensions:\n  dome.agent:\n    enabled: true\n",
        "utf8",
      );
      const policyResult = await loadCapabilityPolicy(root);
      expect(policyResult.ok).toBe(true);
      if (!policyResult.ok) return;
      const granted = policyResult.value.grantsForProcessor(
        "dome.agent",
        "dome.agent.consolidate",
      );
      expect(granted).toContainEqual({
        kind: "patch.propose",
        paths: ["wiki/**/*.md"],
      });

      const bundles = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
      expect(bundles.ok).toBe(true);
      if (!bundles.ok) return;
      const processor = flattenBundleProcessors(bundles.value).find(
        (p) => p.id === "dome.agent.consolidate",
      );
      expect(processor).toBeDefined();
      if (processor === undefined) return;
      expect(processor.capabilities).toContainEqual({
        kind: "patch.propose",
        paths: ["wiki/**/*.md"],
      });

      // Broker-level: feed a real declared/granted pair through the real
      // capability-checked applier with an enqueueProposal sink wired (the
      // shipped shape once proposals.db is threaded in) — the split patch
      // must queue for review, not be denied or dropped.
      const hubRef = sourceRef({
        commit: commitOid("a".repeat(40)),
        path: "wiki/entities/danny.md",
      });
      const splitPatch = patchEffect({
        mode: "propose",
        changes: [
          { kind: "write", path: "wiki/entities/danny.md", content: "hub\n" },
          {
            kind: "write",
            path: "wiki/entities/danny-promo-2026.md",
            content: "sub\n",
          },
        ],
        reason: "dome.agent.consolidate: split danny.md",
        sourceRefs: [hubRef],
      });
      const enqueued: string[] = [];
      const result = await applyEffect({
        processorId: "dome.agent.consolidate",
        extensionId: "dome.agent",
        runId: "run-1" as RunId,
        proposalId: "prop_1_aaaaaa",
        phase: "garden",
        declared: processor.capabilities,
        granted,
        effect: splitPatch,
        candidate: commitOid("0000000000000000000000000000000000000001"),
        sinks: {
          ...noopSinks(),
          enqueueProposal: async (input) => {
            enqueued.push(String(input.effect.reason));
            return { inserted: true, refreshed: false, id: 1 };
          },
        },
      });
      expect(result.outcome).toBe("queued-for-review");
      expect(result.capabilityUse).toEqual({
        capability: "patch.propose",
        resource: "wiki/entities/danny.md,wiki/entities/danny-promo-2026.md",
        outcome: "allowed",
      });
      expect(enqueued).toEqual(["dome.agent.consolidate: split danny.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
