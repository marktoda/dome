import { openVault } from "../../vault";
import { makeDispatcher } from "../../dispatcher";
import { WorkflowRegistry } from "../../prompts/registry";
import { WORKFLOW_NAMES } from "../../workflows/workflow-name";
import { ok, type Result, type ToolError } from "../../types";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface DoctorReport {
  exitCode: 0 | 1;
  violations: string[];
  info: string[];
}

// Optional flags for `dome doctor`. See docs/wiki/specs/cli.md §"dome doctor".
export interface DoctorOpts {
  rebuildIndex?: boolean;
  showReviewQueue?: boolean;
  showRawCitations?: boolean;
  showWorkflows?: boolean;
  showEvents?: boolean;
  showRecentHookCycles?: boolean;
  recentActivity?: boolean;
  drainHooks?: boolean;
  resetQuarantinedHooks?: boolean;
}

// Known event-kind prefixes per docs/wiki/specs/hooks.md §"Event grammar".
// Used by --show events. Centralized here to avoid divergence.
const KNOWN_EVENT_KIND_PREFIXES: ReadonlyArray<string> = [
  "document.written.wiki.*",
  "document.written.inbox.*",
  "document.written.raw",
  "document.written.index",
  "document.written.log",
  "document.deleted.wiki.*",
  "document.deleted.inbox.*",
  "document.deleted.raw",
  "document.deleted.index",
  "document.deleted.log",
  "document.moved",
  "log.appended",
  "vault.out-of-band-edit",
];

// Pluralized wiki subdirectory -> singular page type (per PAGE_TYPE_BY_DIRECTORY).
const WIKI_DIR_TO_PAGE_TYPE: Readonly<Record<string, string>> = {
  entities: "entity",
  concepts: "concept",
  sources: "source",
  syntheses: "synthesis",
};

function expectedPageTypeForDir(dirName: string): string {
  return WIKI_DIR_TO_PAGE_TYPE[dirName] ?? dirName.replace(/s$/, "");
}

export async function domeDoctor(
  vaultPath: string,
  opts: DoctorOpts = {},
): Promise<Result<DoctorReport, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const vault = res.value;

  const violations: string[] = [];
  const info: string[] = [];

  // Wiki page frontmatter checks: type matches directory
  const wikiRoot = join(vault.path, "wiki");
  if (existsSync(wikiRoot)) {
    const subdirs = await readdir(wikiRoot, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        const rel = `wiki/${subdir.name}/${f.name}`;
        const out = await vault.tools.readDocument({ path: rel });
        if (!out.result.ok) continue;
        const doc = out.result.value;
        const expectedType = expectedPageTypeForDir(subdir.name);
        if (doc.frontmatter.type && doc.frontmatter.type !== expectedType) {
          violations.push(`${rel}: frontmatter type=${doc.frontmatter.type} does not match directory ${subdir.name}`);
        }
      }
    }
  }

  // rebuild-index
  if (opts.rebuildIndex) {
    const dispatcher = makeDispatcher(vault.path);
    if (existsSync(wikiRoot)) {
      const subdirs = await readdir(wikiRoot, { withFileTypes: true });
      for (const subdir of subdirs) {
        if (!subdir.isDirectory()) continue;
        const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".md")) continue;
          const rel = `wiki/${subdir.name}/${f.name}`;
          const title = f.name.replace(/\.md$/, "");
          await dispatcher.writeIndex({ path: rel, title });
        }
      }
    }
  }

  // --show workflows: list known workflow names with whether each is present.
  if (opts.showWorkflows) {
    const reg = new WorkflowRegistry(vault);
    const defs = await reg.list();
    const present = new Set(defs.map(d => d.name));
    for (const name of WORKFLOW_NAMES) {
      info.push(`workflow: ${name}${present.has(name) ? "" : " (missing)"}`);
    }
  }

  // --show events: list known event-kind prefixes (read-only catalogue).
  if (opts.showEvents) {
    for (const kind of KNOWN_EVENT_KIND_PREFIXES) info.push(`event: ${kind}`);
  }

  // The remaining flags require runtime state we don't carry across CLI runs in
  // v0.5 (no persistent daemon). Log a no-op note and exit clean.
  if (opts.drainHooks) info.push("--drain-hooks: no-op in v0.5 (no persistent dispatcher state across CLI runs)");
  if (opts.resetQuarantinedHooks) info.push("--reset-quarantined-hooks: no-op in v0.5 (no persistent quarantine state across CLI runs)");
  if (opts.showRecentHookCycles) info.push("--show recent-hook-cycles: no-op in v0.5 (no persistent cycle log across CLI runs)");
  if (opts.showReviewQueue) info.push("--show review-queue: no-op in v0.5 (review-queue lives in wiki/inbox/review-queue.md if present)");
  if (opts.showRawCitations) info.push("--show raw-citations: no-op in v0.5 (raw citations not yet indexed)");
  if (opts.recentActivity) info.push("--recent-activity: no-op in v0.5 (use `git log` against the vault)");

  return ok({ exitCode: violations.length === 0 ? 0 : 1, violations, info });
}
