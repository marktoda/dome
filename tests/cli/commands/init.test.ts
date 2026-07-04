// `dome init` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { runInit } from "../../../src/cli/commands/init";
import { runInspect } from "../../../src/cli/commands/inspect";
import { runSync } from "../../../src/cli/commands/sync";
import {
  resolveShippedBundlesRoot,
  resolveShippedModelProvidersRoot,
  resolveShippedSourceHandlersRoot,
} from "../../../src/cli/commands/sync-shared";
import {
  defaultModelProviderConfig,
  defaultConfigRecord,
} from "../../../src/cli/default-vault-config";
import { loadBundles } from "../../../src/extensions/loader";

import { commit, currentSha, readBlob } from "../../../src/git";
import { openOutboxDb } from "../../../src/outbox/db";
import {
  queryOutbox,
} from "../../../src/outbox/dispatch";
import { openProjectionDb } from "../../../src/projections/db";
import {
  queryDiagnostics,
} from "../../../src/projections/diagnostics";

import {
  captured,
  installConsoleCapture,
  record,
} from "./fixture";

installConsoleCapture();

describe("runInit", () => {
  test("fresh dir → scaffold: dirs, config, orientation files, git+HEAD (no bundle copy)", async () => {
    // Fresh tmpdir — no git repo, no .dome/, no AGENTS.md / CLAUDE.md.
    const target = mkdtempSync(join(tmpdir(), "cli-init-"));
    try {
      const code = await runInit({ path: target });
      expect(code).toBe(0);

      // Scaffold dirs. `.dome/extensions/` is NOT created — the shipped
      // first-party bundles live with the SDK, not in the vault.
      expect(existsSync(join(target, "wiki"))).toBe(true);
      expect(existsSync(join(target, "notes"))).toBe(true);
      expect(existsSync(join(target, "inbox", "raw"))).toBe(true);
      expect(existsSync(join(target, "inbox", "processed"))).toBe(true);
      // `.gitkeep` keeps the inbox dirs tracked once the ingest agent empties
      // inbox/raw/ — a dotfile so it matches neither inbox/raw/*.md (ingest)
      // nor inbox/**/*.md (stale-check).
      expect(existsSync(join(target, "inbox", "raw", ".gitkeep"))).toBe(true);
      expect(
        existsSync(join(target, "inbox", "processed", ".gitkeep")),
      ).toBe(true);
      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
      expect(existsSync(join(target, ".dome", "extensions"))).toBe(false);

      // No bundle directories under .dome/extensions/.
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.lint")),
      ).toBe(false);
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.markdown")),
      ).toBe(false);

      // config.yaml + orientation files present with expected anchors.
      const configPath = join(target, ".dome", "config.yaml");
      expect(existsSync(configPath)).toBe(true);
      const configBody = await readFile(configPath, "utf8");
      expect(configBody).toContain("dome.graph");
      expect(configBody).toContain("dome.lint");
      expect(configBody).toContain("dome.markdown");
      expect(configBody).toContain("max_iterations");
      expect(parseYaml(configBody)).toEqual(defaultConfigRecord());
      expect(existsSync(join(target, ".dome", "model-provider.ts"))).toBe(
        false,
      );

      // core.md — the always-loaded core memory skeleton (commented,
      // propose-only convention + size budget; first-write-only).
      const corePath = join(target, "core.md");
      expect(existsSync(corePath)).toBe(true);
      const coreBody = await readFile(corePath, "utf8");
      expect(coreBody).toContain("# Core memory");
      expect(coreBody).toContain("## Who I am");
      expect(coreBody).toContain("## Active projects");
      expect(coreBody).toContain("## Standing preferences");
      expect(coreBody).toContain("<!--");
      expect(coreBody).toContain("propose-only");
      expect(coreBody).toContain("6,000 characters");
      // The skeleton must itself respect the core-size lint budget.
      expect(coreBody.length).toBeLessThan(6_000);

      // preferences/signals.md — the append-only preference-signal surface
      // (commented header quoting the signal grammar; first-write-only).
      const signalsPath = join(target, "preferences", "signals.md");
      expect(existsSync(signalsPath)).toBe(true);
      const signalsBody = await readFile(signalsPath, "utf8");
      expect(signalsBody).toContain("# Preference signals");
      expect(signalsBody).toContain(
        "- YYYY-MM-DD + <topic-slug>:: <rule> (source: [[page]])",
      );
      expect(signalsBody).toContain("appended, never edited");
      // The header must stay parser-inert: parsePreferenceSignals treats any
      // trimmed line starting with `- ` as a signal candidate and reports
      // grammar misses as problems — so the template may not contain one.
      for (const line of signalsBody.split("\n")) {
        expect(line.trim().startsWith("- ")).toBe(false);
      }

      const agentsPath = join(target, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const agentsBody = await readFile(agentsPath, "utf8");
      expect(agentsBody).toContain("This is a Dome vault");
      expect(agentsBody).toContain("## Daily loop");
      expect(agentsBody).toContain("Commit each coherent unit of work");
      expect(agentsBody).toContain("Dome works at the git commit boundary");
      expect(agentsBody).toContain("serve_status");
      expect(agentsBody).toContain("foreground `dome serve` host");
      expect(agentsBody).toContain("next_actions");
      expect(agentsBody).toContain("dome check --json");
      expect(agentsBody).toContain("dome resolve <id> <value>");
      expect(agentsBody).toContain("agent-safe");
      expect(agentsBody).toContain("owner-needed");
      expect(agentsBody).toContain("recommended_answer");
      expect(agentsBody).toContain("## Read-first context");
      expect(agentsBody).toContain("dome export-context <topic> --json");
      expect(agentsBody).toContain("dome query <text> --json");
      expect(agentsBody).toContain("The daily note should already be");
      expect(agentsBody).not.toContain("dome today");
      // Task 14: prep / agenda-with / stale-claims / orphan-pages are
      // first-class verbs now (no longer behind the hidden `dome run`
      // dispatcher), so the template advertises them directly.
      expect(agentsBody).toContain("dome prep [--date <yyyy-mm-dd>]");
      expect(agentsBody).toContain("dome agenda-with <person-or-topic>");
      expect(agentsBody).toContain("dome stale-claims");
      expect(agentsBody).toContain("dome orphan-pages");
      expect(agentsBody).toContain("dome export-context <topic>");
      expect(agentsBody).toContain("Advanced/debug commands");
      expect(agentsBody).toContain("dome inspect <subject>");
      expect(agentsBody).toContain("dome inspect bundles --json");
      expect(agentsBody).toContain("inbox/raw/");
      expect(agentsBody).toContain("dome.agent");
      expect(agentsBody).toContain('model: "ready"');
      expect(agentsBody).toContain("Do not edit or commit it");
      expect(agentsBody).toContain("<!-- BEGIN user-prose -->");
      expect(agentsBody).toContain("<!-- END user-prose -->");
      expect(agentsBody).not.toContain("git worktree add");
      // Foreground signal contract: a managed "Preference signals" section
      // with the exact grammar, explicit-statements-only rule, and the
      // owner-mediated promotion boundary.
      expect(agentsBody).toContain("## Preference signals");
      expect(agentsBody).toContain(
        "- YYYY-MM-DD + <topic-slug>:: <rule> (source: [[page]])",
      );
      expect(agentsBody).toContain("never infer");
      expect(agentsBody).toContain("owner-mediated");
      // The grammar is quoted exactly once (template length discipline).
      expect(
        agentsBody.split("- YYYY-MM-DD + <topic-slug>::").length,
      ).toBe(2);
      // `dome log` is the activity view (3a deferred item).
      expect(agentsBody).toContain("dome log");
      expect(agentsBody).toContain("activity view");
      // Vault conventions: wiki structure, inbox roles, sources day-files, and
      // config/state directories — the core contract agents operate in.
      expect(agentsBody).toContain("## Vault conventions");
      expect(agentsBody).toContain("sources/<kind>/<date>.md");
      expect(agentsBody).toContain("weaves whatever exists into the daily");
      // Authoring conventions: page-type schema, source-backing, claim/task
      // anchors, and generated-block awareness — the cross-client quality
      // multiplier so an arbitrary agent writes adoption-clean pages.
      expect(agentsBody).toContain("## Writing wiki pages");
      expect(agentsBody).toContain("wiki/entities/");
      expect(agentsBody).toContain("wiki/syntheses/");
      expect(agentsBody).toContain("source-backing is the point");
      expect(agentsBody).toContain("**Key:**"); // claim line grammar
      expect(agentsBody).toContain("^c…"); // claim anchor — never hand-edit
      expect(agentsBody).toContain("^t…"); // task anchor — move-stable identity
      expect(agentsBody).toContain("**Generated blocks.**");
      expect(agentsBody).toContain("machine-regenerated"); // generated-block awareness (no literal marker token — splice-guard)

      const claudePath = join(target, "CLAUDE.md");
      expect(existsSync(claudePath)).toBe(true);
      const claudeBody = await readFile(claudePath, "utf8");
      expect(claudeBody.startsWith("@AGENTS.md")).toBe(true);
      expect(claudeBody).toContain("dome status --json");
      expect(claudeBody).toContain("next_actions");
      expect(claudeBody).toContain("dome sync --json");
      expect(claudeBody).toContain("dome check --json");
      expect(claudeBody).toContain("dome resolve <id> <value>");
      expect(claudeBody).toContain("before broad manual file hunting");
      expect(claudeBody).toContain("agent-safe");
      expect(claudeBody).toContain("owner-needed");
      expect(claudeBody).not.toContain("only use `dome status`");
      expect(captured.out.join("\n")).toContain("CLAUDE.md");
      expect(captured.out.join("\n")).toContain("inbox/raw/");
      expect(captured.out.join("\n")).toContain(".dome/model-provider.ts");

      // Git initialized + HEAD resolves (the initial scaffold commit landed).
      expect(existsSync(join(target, ".git"))).toBe(true);
      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head !== null) {
        expect(
          await readBlob({ path: target, commit: head, filepath: "AGENTS.md" }),
        ).toBe(agentsBody);
        expect(
          await readBlob({ path: target, commit: head, filepath: "CLAUDE.md" }),
        ).toBe(claudeBody);
        expect(
          await readBlob({ path: target, commit: head, filepath: "core.md" }),
        ).toBe(coreBody);
        expect(
          await readBlob({
            path: target,
            commit: head,
            filepath: "preferences/signals.md",
          }),
        ).toBe(signalsBody);
      }

      // The SDK-shipped bundles are still loadable from the resolved
      // shipped-bundles root. This is the load-bearing assertion that
      // replaces the dropped per-file bundle-copy checks above.
      const bundlesRoot = resolveShippedBundlesRoot();
      const loaded = await loadBundles({ bundlesRoot });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const ids = loaded.value.map((b) => b.id);
        expect(ids).toContain("dome.graph");
        expect(ids).toContain("dome.agent");
        expect(ids).toContain("dome.lint");
        expect(ids).toContain("dome.markdown");
      }
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--with-model-provider anthropic writes a vault-local command provider", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-provider-"));
    try {
      const code = await runInit({
        path: target,
        modelProvider: "anthropic",
      });
      expect(code).toBe(0);

      const configPath = join(target, ".dome", "config.yaml");
      const providerPath = join(target, ".dome", "model-provider.ts");
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(providerPath)).toBe(true);

      const configBody = await readFile(configPath, "utf8");
      expect(parseYaml(configBody)).toEqual(
        defaultConfigRecord({ modelProvider: "anthropic" }),
      );
      const parsedConfig = record(parseYaml(configBody));
      expect(parsedConfig.model_provider).toEqual(
        defaultModelProviderConfig("anthropic"),
      );
      const extensions = record(parsedConfig.extensions);
      // dome.agent ships enabled by default (product-review-3 Task 17);
      // --with-model-provider wires the provider the already-enabled agent
      // needs, it does not itself flip enablement.
      expect(record(extensions["dome.agent"]).enabled).toBe(true);

      const providerBody = await readFile(providerPath, "utf8");
      expect(providerBody.startsWith("#!/usr/bin/env bun")).toBe(true);
      expect(providerBody).toContain("ANTHROPIC_API_KEY");
      expect(providerBody).toContain("claude-sonnet-4-6");
      expect(providerBody).toContain("dome.model-provider.request/v1");
      expect(providerBody).toContain("dome.model-provider.step/v1");
      expect(providerBody).toContain("dome.model-provider.probe/v1");

      // The written provider is a byte-for-byte copy of the shipped asset
      // template — init copies data, it does not generate code.
      const assetBody = await readFile(
        join(resolveShippedModelProvidersRoot(), "anthropic.ts"),
        "utf8",
      );
      expect(providerBody).toBe(assetBody);

      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head !== null) {
        expect(
          await readBlob({
            path: target,
            commit: head,
            filepath: ".dome/config.yaml",
          }),
        ).toBe(configBody);
        expect(
          await readBlob({
            path: target,
            commit: head,
            filepath: ".dome/model-provider.ts",
          }),
        ).toBe(providerBody);
      }

      expect(await runInit({ path: target, modelProvider: "anthropic" })).toBe(
        0,
      );
      expect(await readFile(configPath, "utf8")).toBe(configBody);
      expect(await readFile(providerPath, "utf8")).toBe(providerBody);
      expect(await currentSha(target)).toBe(head);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--with-source scaffolds fetch adapters + disabled subscription stanzas (fresh vault)", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-sources-"));
    try {
      const code = await runInit({
        path: target,
        withSource: ["calendar", "slack"],
      });
      expect(code).toBe(0);

      const configPath = join(target, ".dome", "config.yaml");
      const calendarScript = join(target, ".dome", "bin", "fetch-calendar.sh");
      const slackScript = join(target, ".dome", "bin", "fetch-slack.sh");
      expect(existsSync(calendarScript)).toBe(true);
      expect(existsSync(slackScript)).toBe(true);

      // Executable bit: the subscription command is `sh .dome/bin/...`, but
      // the scaffolded script must also be directly runnable.
      expect(statSync(calendarScript).mode & 0o111).not.toBe(0);
      expect(statSync(slackScript).mode & 0o111).not.toBe(0);

      // Byte-for-byte copies of the shipped templates — init copies data,
      // it does not generate code.
      const handlersRoot = resolveShippedSourceHandlersRoot();
      expect(await readFile(calendarScript, "utf8")).toBe(
        await readFile(join(handlersRoot, "claude-calendar.sh"), "utf8"),
      );
      expect(await readFile(slackScript, "utf8")).toBe(
        await readFile(join(handlersRoot, "claude-slack.sh"), "utf8"),
      );

      // Config carries BOTH subscription stanzas, each enabled: false (the
      // consent flip stays with the owner), with the standard schedule /
      // output_path / command.
      const configBody = await readFile(configPath, "utf8");
      expect(parseYaml(configBody)).toEqual(
        defaultConfigRecord({ sources: ["calendar", "slack"] }),
      );
      const parsedConfig = record(parseYaml(configBody));
      const sources = record(record(parsedConfig.extensions)["dome.sources"]);
      const subscriptions = record(record(sources.config).subscriptions);
      expect(subscriptions.calendar).toEqual({
        enabled: false,
        schedule: "10 5 * * *",
        output_path: "sources/calendar/{date}.md",
        command: ["sh", ".dome/bin/fetch-calendar.sh"],
      });
      expect(subscriptions.slack).toEqual({
        enabled: false,
        schedule: "15 5 * * *",
        output_path: "sources/slack/{date}.md",
        command: ["sh", ".dome/bin/fetch-slack.sh"],
      });

      // The scaffold commit includes the scripts (mirrors model-provider).
      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head !== null) {
        expect(
          await readBlob({
            path: target,
            commit: head,
            filepath: ".dome/bin/fetch-slack.sh",
          }),
        ).toBe(await readFile(slackScript, "utf8"));
      }

      // Idempotent re-run: nothing changes, no new commit.
      expect(
        await runInit({ path: target, withSource: ["calendar", "slack"] }),
      ).toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(configBody);
      expect(await currentSha(target)).toBe(head);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--with-source slack on an EXISTING vault adds script + stanza without touching anything else", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-sources-existing-"));
    try {
      // A plain vault first (the work-vault use case).
      expect(await runInit({ path: target })).toBe(0);
      const configPath = join(target, ".dome", "config.yaml");
      const agentsBody = await readFile(join(target, "AGENTS.md"), "utf8");
      const head = await currentSha(target);

      expect(await runInit({ path: target, withSource: ["slack"] })).toBe(0);

      const slackScript = join(target, ".dome", "bin", "fetch-slack.sh");
      expect(existsSync(slackScript)).toBe(true);
      expect(statSync(slackScript).mode & 0o111).not.toBe(0);

      const parsedConfig = record(
        parseYaml(await readFile(configPath, "utf8")),
      );
      const sources = record(record(parsedConfig.extensions)["dome.sources"]);
      const subscriptions = record(record(sources.config).subscriptions);
      expect(record(subscriptions.slack).enabled).toBe(false);
      // The pre-existing calendar default stanza is untouched.
      expect(subscriptions.calendar).toEqual({
        enabled: false,
        schedule: "10 5 * * *",
        output_path: "sources/calendar/{date}.md",
        command: ["sh", ".dome/bin/fetch-calendar.sh"],
      });
      // Everything else parses identically to the defaults with slack added.
      expect(parseYaml(await readFile(configPath, "utf8"))).toEqual(
        defaultConfigRecord({ sources: ["slack"] }),
      );
      // Orientation untouched; no new commit (existing vault, HEAD already
      // resolved — committing the new files stays with the owner).
      expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(agentsBody);
      expect(await currentSha(target)).toBe(head);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--with-source never overwrites an existing script or flips an existing enabled", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-sources-owned-"));
    try {
      expect(await runInit({ path: target, withSource: ["slack"] })).toBe(0);

      // Owner reviews the script, edits it, and flips consent on.
      const slackScript = join(target, ".dome", "bin", "fetch-slack.sh");
      const ownScript = "#!/bin/sh\necho mine\n";
      await writeFile(slackScript, ownScript, "utf8");
      const configPath = join(target, ".dome", "config.yaml");
      const root = record(parseYaml(await readFile(configPath, "utf8")));
      const sources = record(record(root.extensions)["dome.sources"]);
      const subscriptions = record(record(sources.config).subscriptions);
      record(subscriptions.slack).enabled = true;
      const { stringify } = await import("yaml");
      await writeFile(configPath, stringify(root), "utf8");

      expect(await runInit({ path: target, withSource: ["slack"] })).toBe(0);

      expect(await readFile(slackScript, "utf8")).toBe(ownScript);
      const after = record(parseYaml(await readFile(configPath, "utf8")));
      const afterSources = record(record(after.extensions)["dome.sources"]);
      const afterSubs = record(record(afterSources.config).subscriptions);
      expect(record(afterSubs.slack).enabled).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  // ----- comment-preserving config edits -----------------------------------
  //
  // The init ensure-paths (`--with-model-provider`, `--with-source`,
  // `--refresh-config`) edit `.dome/config.yaml` through the yaml package's
  // Document API (parseDocument → targeted edits → stringify), which keeps
  // hand-written comments and formatting intact instead of round-tripping
  // through plain objects (which deleted every comment). Documented caveat
  // (empirically observed against yaml@2.9; deliberately absent from the
  // fixture below, which asserts byte-for-byte line preservation): an inline
  // comment trailing a block-collection KEY (`calendar: # note`) is
  // repositioned onto the next line; it is never deleted. Comments above
  // lines and inline after scalar values survive byte-for-byte.

  const COMMENTED_CONFIG = [
    "# top-of-file comment the owner wrote",
    "extensions:",
    "  # daily bundle — hand-tuned by the owner",
    "  dome.daily:",
    "    enabled: true # keep on",
    "    grant:",
    "      read:",
    '        - "wiki/**/*.md" # only the wiki',
    "  dome.sources:",
    "    enabled: true",
    "    config:",
    "      subscriptions:",
    "        calendar:",
    "          # the owner's hand-tuned schedule",
    "          enabled: true",
    '          schedule: "10 5 * * *"',
    '          output_path: "sources/calendar/{date}.md"',
    '          command: ["sh", ".dome/bin/fetch-calendar.sh"]',
    "    grant:",
    '      read: ["sources/**/*.md"]',
    "engine:",
    "  max_iterations: 25 # owner note",
    "",
  ].join("\n");

  /** Every line of `original` appears in `after`, in order (insert-only edit). */
  function expectLinesPreservedInOrder(original: string, after: string): void {
    const afterLines = after.split("\n");
    let cursor = 0;
    for (const line of original.split("\n")) {
      const found = afterLines.indexOf(line, cursor);
      expect(found).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  }

  test("--with-source slack preserves hand-written comments (insert-only edit)", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-comments-source-"));
    try {
      await mkdir(join(target, ".dome"), { recursive: true });
      const configPath = join(target, ".dome", "config.yaml");
      await writeFile(configPath, COMMENTED_CONFIG, "utf8");

      expect(await runInit({ path: target, withSource: ["slack"] })).toBe(0);

      const after = await readFile(configPath, "utf8");
      // Every original line — comments included — survives in order; the
      // slack stanza is the only addition.
      expectLinesPreservedInOrder(COMMENTED_CONFIG, after);
      const subscriptions = record(
        record(
          record(record(record(parseYaml(after)).extensions)["dome.sources"])
            .config,
        ).subscriptions,
      );
      expect(subscriptions.slack).toEqual({
        enabled: false,
        schedule: "15 5 * * *",
        output_path: "sources/slack/{date}.md",
        command: ["sh", ".dome/bin/fetch-slack.sh"],
      });
      // The hand-tuned calendar stanza is byte-untouched (still enabled).
      expect(record(subscriptions.calendar).enabled).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--with-model-provider preserves hand-written comments (insert-only edit)", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-comments-provider-"));
    try {
      await mkdir(join(target, ".dome"), { recursive: true });
      const configPath = join(target, ".dome", "config.yaml");
      await writeFile(configPath, COMMENTED_CONFIG, "utf8");

      expect(await runInit({ path: target, modelProvider: "anthropic" })).toBe(
        0,
      );

      const after = await readFile(configPath, "utf8");
      expectLinesPreservedInOrder(COMMENTED_CONFIG, after);
      expect(record(parseYaml(after)).model_provider).toEqual(
        defaultModelProviderConfig("anthropic"),
      );
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--refresh-config preserves hand-written comments while filling defaults", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-comments-refresh-"));
    try {
      await mkdir(join(target, ".dome"), { recursive: true });
      const configPath = join(target, ".dome", "config.yaml");
      await writeFile(configPath, COMMENTED_CONFIG, "utf8");

      expect(await runInit({ path: target, refreshConfig: true })).toBe(0);

      const after = await readFile(configPath, "utf8");
      expectLinesPreservedInOrder(COMMENTED_CONFIG, after);
      const refreshed = record(parseYaml(after));
      const extensions = record(refreshed.extensions);
      // Missing first-party stanzas were filled ...
      expect(record(extensions["dome.lint"]).enabled).toBe(true);
      expect(record(extensions["dome.markdown"]).enabled).toBe(true);
      // ... missing grant keys on the enabled commented bundle were filled ...
      expect(record(record(extensions["dome.daily"]).grant)["patch.auto"])
        .toEqual(["wiki/**/*.md", "notes/*.md"]);
      // ... and the owner's narrowed read grant value was NOT changed.
      expect(record(record(extensions["dome.daily"]).grant).read).toEqual([
        "wiki/**/*.md",
      ]);
      expect(record(refreshed.engine).max_iterations).toBe(25);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--json emits a stable initialization summary", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-json-"));
    try {
      const code = await runInit({ path: target, json: true });
      expect(code).toBe(0);
      const parsed = JSON.parse(captured.out.join("\n")) as {
        readonly schema: string;
        readonly status: string;
        readonly vault: string;
        readonly steps: Record<string, string>;
      };
      expect(parsed.schema).toBe("dome.init/v1");
      expect(parsed.status).toBe("initialized");
      expect(parsed.vault).toBe(target);
      expect(parsed.steps.config_yaml).toBe("created");
      expect(parsed.steps.core_md).toBe("created");
      expect(parsed.steps.signals_md).toBe("created");
      expect(parsed.steps.initial_commit).toBe("created");
      expect(parsed.steps.model_provider).toBe("skipped (not requested)");
      expect(parsed.steps.sources).toBe("skipped (not requested)");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("is idempotent — re-run leaves orientation files byte-identical + no errors", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-idem-"));
    try {
      expect(await runInit({ path: target })).toBe(0);

      const agentsPath = join(target, "AGENTS.md");
      const claudePath = join(target, "CLAUDE.md");
      const corePath = join(target, "core.md");
      const signalsPath = join(target, "preferences", "signals.md");
      const configPath = join(target, ".dome", "config.yaml");
      const firstAgents = await readFile(agentsPath, "utf8");
      const firstClaude = await readFile(claudePath, "utf8");
      const firstConfig = await readFile(configPath, "utf8");
      const firstHead = await currentSha(target);

      // Mutate the user-prose region, Claude-specific shim notes, and the
      // core memory page to confirm `dome init` doesn't clobber post-init
      // edits. core.md is the user's core memory — there is no refresh path
      // for it at all.
      const mutatedAgents = firstAgents.replace(
        "<!-- BEGIN user-prose -->",
        "<!-- BEGIN user-prose -->\n\nMy private vault notes.",
      );
      const mutatedClaude = `${firstClaude}\nPersonal Claude Code reminder.\n`;
      const mutatedCore =
        "# Core memory\n\n## Who I am\nMark — builds Dome.\n";
      // signals.md is append-only owner data — accumulated signal lines
      // must survive re-init byte-for-byte (no refresh path, like core.md).
      const mutatedSignals =
        (await readFile(signalsPath, "utf8")) +
        "- 2026-06-11 + filing:: meeting notes go under wiki/meetings\n";
      await writeFile(agentsPath, mutatedAgents, "utf8");
      await writeFile(claudePath, mutatedClaude, "utf8");
      await writeFile(corePath, mutatedCore, "utf8");
      await writeFile(signalsPath, mutatedSignals, "utf8");

      expect(await runInit({ path: target })).toBe(0);

      const secondAgents = await readFile(agentsPath, "utf8");
      const secondClaude = await readFile(claudePath, "utf8");
      const secondCore = await readFile(corePath, "utf8");
      const secondSignals = await readFile(signalsPath, "utf8");
      const secondConfig = await readFile(configPath, "utf8");
      const secondHead = await currentSha(target);

      // Orientation mutations survive re-init; config untouched; HEAD
      // didn't advance (no second commit landed).
      expect(secondAgents).toBe(mutatedAgents);
      expect(secondClaude).toBe(mutatedClaude);
      expect(secondCore).toBe(mutatedCore);
      expect(secondSignals).toBe(mutatedSignals);
      expect(secondConfig).toBe(firstConfig);
      expect(secondHead).toBe(firstHead);

      // A refresh re-run also leaves core.md and signals.md alone —
      // `--refresh-config` / `--refresh-instructions` have no path to
      // either (both are owner data).
      expect(
        await runInit({
          path: target,
          refreshConfig: true,
          refreshInstructions: true,
        }),
      ).toBe(0);
      expect(await readFile(corePath, "utf8")).toBe(mutatedCore);
      expect(await readFile(signalsPath, "utf8")).toBe(mutatedSignals);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--refresh-config adds missing first-party bundles and fills default grant keys", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-refresh-"));
    try {
      await mkdir(join(target, ".dome"), { recursive: true });
      const configPath = join(target, ".dome", "config.yaml");
      await writeFile(
        configPath,
        "extensions:\n" +
          "  dome.lint:\n" +
          "    enabled: true\n" +
          "  dome.markdown:\n" +
          "    enabled: true\n" +
          "    grant:\n" +
          "      read:\n" +
          "        - \"notes/**/*.md\"\n" +
          "  dome.search:\n" +
          "    enabled: true\n" +
          "    grants:\n" +
          "      read:\n" +
          "        - \"wiki/**/*.md\"\n" +
          "  dome.health:\n" +
          "    enabled: false\n" +
          "  custom.local:\n" +
          "    enabled: true\n" +
          "engine:\n" +
          "  max_iterations: 25\n",
        "utf8",
      );

      expect(await runInit({ path: target, refreshConfig: true })).toBe(0);
      const refreshed = parseYaml(await readFile(configPath, "utf8")) as {
        readonly extensions: Record<string, {
          readonly enabled?: boolean;
          readonly grant?: Record<string, unknown>;
          readonly grants?: Record<string, unknown>;
        }>;
        readonly engine: { readonly max_iterations: number };
      };

      expect(refreshed.extensions["dome.lint"]?.grant?.read).toEqual([
        "**/*.md",
      ]);
      expect(refreshed.extensions["dome.markdown"]?.grant?.read).toEqual([
        "notes/**/*.md",
      ]);
      expect(refreshed.extensions["dome.markdown"]?.grant?.["patch.auto"])
        .toEqual(["**/*.md"]);
      expect(refreshed.extensions["dome.markdown"]?.grant?.["question.ask"])
        .toBe(true);
      expect(refreshed.extensions["dome.search"]?.grants?.read).toEqual([
        "wiki/**/*.md",
      ]);
      expect(refreshed.extensions["dome.search"]?.grants?.["search.write"])
        .toEqual(["**/*.md"]);
      expect(refreshed.extensions["dome.graph"]?.grant?.["graph.write"])
        .toEqual(["dome.graph.*"]);
      expect(refreshed.extensions["dome.daily"]?.enabled).toBe(true);
      expect(refreshed.extensions["dome.daily"]?.grant?.["patch.auto"])
        .toEqual(["wiki/**/*.md", "notes/*.md"]);
      expect(refreshed.extensions["dome.health"]?.enabled).toBe(false);
      // dome.agent was absent from the hand-written config above, so refresh
      // adds the whole stanza from the current shipped default — which now
      // ships enabled: true (product-review-3 Task 17), same as dome.daily
      // above. dome.health, by contrast, was explicitly written `enabled:
      // false` already and refresh must leave an explicit value alone.
      expect(refreshed.extensions["dome.agent"]?.enabled).toBe(true);
      expect(refreshed.extensions["custom.local"]?.grant).toBeUndefined();
      expect(refreshed.engine.max_iterations).toBe(25);

      const firstRefresh = await readFile(configPath, "utf8");
      expect(await runInit({ path: target, refreshConfig: true })).toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(firstRefresh);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--refresh-instructions repairs old orientation shims", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-instructions-"));
    try {
      await writeFile(
        join(target, "AGENTS.md"),
        "# Old instructions\n\nKeep this vault-specific guidance.\n",
        "utf8",
      );
      await writeFile(
        join(target, "CLAUDE.md"),
        "# Work Knowledge Base\n\nOld Claude-specific memory.\n",
        "utf8",
      );

      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      const claude = await readFile(join(target, "CLAUDE.md"), "utf8");
      expect(agents).toContain("# Old instructions");
      expect(agents).toContain("Keep this vault-specific guidance.");
      expect(agents).toContain("## Read-first context");
      expect(agents).toContain("<!-- BEGIN user-prose -->");
      expect(agents).toContain("<!-- END user-prose -->");
      expect(claude.startsWith("@AGENTS.md\n\n# Work Knowledge Base")).toBe(true);
      expect(claude).toContain("Old Claude-specific memory.");

      const firstAgents = agents;
      const firstClaude = claude;
      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);
      expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(firstAgents);
      expect(await readFile(join(target, "CLAUDE.md"), "utf8")).toBe(firstClaude);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--refresh-instructions refreshes managed AGENTS while preserving user prose", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-managed-agents-"));
    try {
      await writeFile(
        join(target, "AGENTS.md"),
        [
          "# Old managed heading",
          "",
          "Outdated instruction: use dome doctor --show diagnostics.",
          "",
          "<!-- BEGIN user-prose -->",
          "",
          "My private vault notes.",
          "",
          "<!-- END user-prose -->",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(target, "CLAUDE.md"), "@AGENTS.md\n", "utf8");

      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      expect(agents.startsWith("# This is a Dome vault.")).toBe(true);
      expect(agents).toContain("## Read-first context");
      expect(agents).toContain("dome export-context <topic> --json");
      expect(agents).toContain("My private vault notes.");
      expect(agents).not.toContain("# Old managed heading");
      expect(agents).not.toContain("doctor --show");
      // The refresh adds the newer managed sections to an older vault while
      // the user prose above survived untouched.
      expect(agents).toContain("## Preference signals");
      expect(agents).toContain("dome log");
      // And the refresh run scaffolds the signal surface an old vault lacks.
      expect(existsSync(join(target, "preferences", "signals.md"))).toBe(true);

      const firstAgents = agents;
      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);
      expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(firstAgents);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test(
    "end-to-end demo: init → sync init → broken wikilink commit → sync → diagnostic lands",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-init-e2e-"));
      try {
        // Step 1: dome init produces a fully-scaffolded vault with an
        //         initial commit on `main` (HEAD resolves; the adopted
        //         ref is still uninitialized — first `dome sync`
        //         empty-diff-initializes it).
        expect(await runInit({ path: target })).toBe(0);

        // Phase 11f: `dome sync` defaults `--bundles-root` to the SDK's
        // shipped `assets/extensions/` directory via
        // `resolveShippedBundlesRoot`. The vault doesn't carry any
        // bundle copies; the runtime resolves them at the SDK source.
        // This test runs without `--bundles-root` to exercise the
        // production demo path.

        // Step 2: initialize the adopted ref. Per detectDrift, an
        //         uninitialized adopted ref surfaces as an empty-diff
        //         drift (base === head === HEAD); the engine runs a
        //         no-effect iteration and advances the ref so the next
        //         sync can compute a real diff.
        expect(
          await runSync({ vault: target }),
        ).toBe(0);

        // Step 3: user writes a markdown file with a broken wikilink.
        await writeFile(join(target, "wiki", "foo.md"), "[[broken]]\n", "utf8");

        // Step 4: user commits the new file.
        await commit({
          path: target,
          message: "add wiki/foo.md\n",
          files: ["wiki/foo.md"],
        });

        // Step 5: dome sync — this run sees base=initial-scaffold,
        //         head=new-commit, emits `file.created` +
        //         `document.changed` for wiki/foo.md, and
        //         dome.markdown.validate-wikilinks fires.
        expect(
          await runSync({ vault: target }),
        ).toBe(0);

        // Step 6: the broken-wikilink diagnostic lands in the projection.
        const projectionPath = join(target, ".dome", "state", "projection.db");
        expect(existsSync(projectionPath)).toBe(true);

        const projectionResult = await openProjectionDb({
          path: projectionPath,
          extensionSet: [
            { name: "dome.lint", version: "0.1.0" },
            { name: "dome.markdown", version: "0.1.0" },
          ],
          processorVersions: [
            { id: "dome.lint.report", version: "0.1.1" },
            { id: "dome.markdown.validate-wikilinks", version: "0.1.0" },
          ],
          capabilityPolicyHash: "test-policy",
        });
        expect(projectionResult.ok).toBe(true);
        if (!projectionResult.ok) return;

        try {
          const diagnostics = queryDiagnostics(projectionResult.value.db);
          const broken = diagnostics.find(
            (d) => d.code === "dome.markdown.broken-wikilink",
          );
          expect(broken).toBeDefined();
          expect(broken?.message).toContain("[[broken]]");
        } finally {
          projectionResult.value.db.close();
        }

        // Step 7: the broken-wikilink must also appear in the user-facing
        // CLI output. Regression: before queryDiagnostics ordered DESC, a
        // user with N>20 accumulated diagnostics couldn't see freshly-
        // emitted ones in `dome inspect diagnostics`'s default view. The
        // DB had the row; the CLI didn't surface it. This step is the
        // structural fence against that class of UX bug: we assert the
        // freshest diagnostic appears in the CLI's default-limit output.
        captured.out = [];
        captured.err = [];
        const inspectCode = await runInspect(
          { subject: "diagnostics", vault: target },
        );
        expect(inspectCode).toBe(0);
        const inspectOut = captured.out.join("\n");
        // The message "Wikilink [[broken]] does not resolve..." may be
        // truncated by the width-fit table column; check the visible prefix.
        expect(inspectOut).toContain("[[broken]");
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    // The end-to-end test spins up two full adoption runs (the
    // empty-diff init + the wiki/foo.md drift) and opens four sqlite
    // handles across the engine + the test's direct projection read.
    // 30s is comfortably above the observed runtime on CI.
    30_000,
  );

  test(
    "default CLI bundle roots compose shipped bundles with vault-local bundles",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-local-bundle-"));
      try {
        expect(await runInit({ path: target })).toBe(0);
        await writeLocalDiagnosticBundle(target);
        await appendLocalBundleConfig(target);
        await commit({
          path: target,
          message: "enable custom local bundle\n",
          files: [
            ".dome/config.yaml",
            ".dome/extensions/custom.local/manifest.json",
            ".dome/extensions/custom.local/processors/audit.ts",
          ],
        });

        expect(await runSync({ vault: target })).toBe(0);

        await writeFile(
          join(target, "wiki", "local.md"),
          "# Local bundle proof\n",
          "utf8",
        );
        await commit({
          path: target,
          message: "add local bundle proof page\n",
          files: ["wiki/local.md"],
        });

        expect(await runSync({ vault: target })).toBe(0);

        captured.out = [];
        captured.err = [];
        const inspectCode = await runInspect({
          subject: "diagnostics",
          vault: target,
          code: "custom.local.seen",
          json: true,
        });
        expect(inspectCode).toBe(0);
        const diagnostics = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
          readonly code: string;
          readonly message: string;
        }>;
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            code: "custom.local.seen",
            message: "Vault-local bundle ran through the default composed root.",
          }),
        );
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "vault-local bundle external handlers dispatch ExternalActionEffect rows",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-local-handler-"));
      try {
        expect(await runInit({ path: target })).toBe(0);
        await writeLocalExternalHandlerBundle(target);
        await appendLocalExternalHandlerConfig(target);
        await commit({
          path: target,
          message: "enable local external handler bundle\n",
          files: [
            ".dome/config.yaml",
            ".dome/extensions/custom.external/manifest.json",
            ".dome/extensions/custom.external/processors/emit.ts",
            ".dome/extensions/custom.external/external-handlers/calendar.write.ts",
          ],
        });

        expect(await runSync({ vault: target })).toBe(0);

        await writeFile(
          join(target, "wiki", "handler.md"),
          "# Handler proof\n",
          "utf8",
        );
        await commit({
          path: target,
          message: "trigger local external handler\n",
          files: ["wiki/handler.md"],
        });

        expect(await runSync({ vault: target })).toBe(0);

        const outboxResult = await openOutboxDb({
          path: join(target, ".dome", "state", "outbox.db"),
        });
        expect(outboxResult.ok).toBe(true);
        if (!outboxResult.ok) return;
        try {
          const row = queryOutbox(outboxResult.value.db, {
            capability: "calendar.write",
          })[0];
          expect(row).toEqual(
            expect.objectContaining({
              idempotencyKey: "custom.external:wiki/handler.md",
              status: "sent",
              externalId: "local-handler:wiki/handler.md",
            }),
          );
        } finally {
          outboxResult.value.db.close();
        }
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

async function appendLocalBundleConfig(target: string): Promise<void> {
  const configPath = join(target, ".dome", "config.yaml");
  const config = await readFile(configPath, "utf8");
  const localBundleStanza = `  custom.local:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
`;
  await writeFile(
    configPath,
    config.replace("\nengine:\n", `\n${localBundleStanza}\nengine:\n`),
    "utf8",
  );
}

async function writeLocalDiagnosticBundle(target: string): Promise<void> {
  const bundleDir = join(target, ".dome", "extensions", "custom.local");
  const processorsDir = join(bundleDir, "processors");
  await mkdir(processorsDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: "custom.local",
      version: "0.1.0",
      processors: [
        {
          id: "custom.local.audit",
          version: "0.1.0",
          phase: "adoption",
          triggers: [
            {
              kind: "signal",
              name: "file.created",
              pathPattern: "wiki/**/*.md",
            },
          ],
          capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
          module: "processors/audit.ts",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(processorsDir, "audit.ts"),
    `
      export default {
        async run(ctx) {
          return [{
            kind: "diagnostic",
            severity: "info",
            code: "custom.local.seen",
            message: "Vault-local bundle ran through the default composed root.",
            sourceRefs: [ctx.sourceRef("wiki/local.md")],
          }];
        },
      };
    `,
    "utf8",
  );
}

async function appendLocalExternalHandlerConfig(target: string): Promise<void> {
  const configPath = join(target, ".dome", "config.yaml");
  const config = await readFile(configPath, "utf8");
  const localBundleStanza = `  custom.external:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      external: ["calendar.write"]
`;
  await writeFile(
    configPath,
    config.replace("\nengine:\n", `\n${localBundleStanza}\nengine:\n`),
    "utf8",
  );
}

async function writeLocalExternalHandlerBundle(target: string): Promise<void> {
  const bundleDir = join(target, ".dome", "extensions", "custom.external");
  const processorsDir = join(bundleDir, "processors");
  const handlersDir = join(bundleDir, "external-handlers");
  await mkdir(processorsDir, { recursive: true });
  await mkdir(handlersDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: "custom.external",
      version: "0.1.0",
      processors: [
        {
          id: "custom.external.emit",
          version: "0.1.0",
          phase: "garden",
          triggers: [
            {
              kind: "signal",
              name: "file.created",
              pathPattern: "wiki/handler.md",
            },
          ],
          capabilities: [
            { kind: "read", paths: ["wiki/**/*.md"] },
            { kind: "external", capability: "calendar.write" },
          ],
          module: "processors/emit.ts",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(processorsDir, "emit.ts"),
    `
      export default {
        async run(ctx) {
          const path = "wiki/handler.md";
          const content = await ctx.snapshot.readFile(path);
          if (content === null) return [];
          return [{
            kind: "external",
            capability: "calendar.write",
            idempotencyKey: "custom.external:" + path,
            payload: { path },
            sourceRefs: [ctx.sourceRef(path)],
          }];
        },
      };
    `,
    "utf8",
  );
  await writeFile(
    join(handlersDir, "calendar.write.ts"),
    `
      export default async function handle(input) {
        return { externalId: "local-handler:" + input.payload.path };
      }
    `,
    "utf8",
  );
}

