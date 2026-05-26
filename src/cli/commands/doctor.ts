import { openVault, type Vault } from "../../vault";
import { WorkflowRegistry } from "../../prompts/registry";
import { WORKFLOW_NAMES } from "../../workflows/workflow-name";
import { parseWikilinks } from "../../wikilinks";
import { pluralOf, singularOf } from "../../page-type";
import { walkMd } from "../../vault-fs";
import { ok, type Result, type ToolError } from "../../types";
import { readdir, stat } from "node:fs/promises";
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
  /**
   * When set, print the last N entries from `log.md` as info lines prefixed
   * with `recent:`. `null` means use the default (50). `undefined` means
   * the flag wasn't passed and no walk runs.
   */
  recentActivityN?: number | null;
  drainHooks?: boolean;
  resetQuarantinedHooks?: boolean;
  /**
   * Report how long it's been since the daemon last reconciled (read from
   * .dome/state/last-reconciled-sha.txt mtime). See
   * docs/wiki/gotchas/daemon-off-while-vault-mutating.md.
   */
  timeSinceReconcile?: boolean;
  /**
   * When set, regenerate AGENTS.md templated sections from current config
   * while preserving the user-prose section. Per
   * docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md.
   */
  repair?: boolean;
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

// Universal frontmatter keys allowed on EVERY wiki page (per page-schema.md
// §"Universal frontmatter"). Per-type extensions are layered on top via
// PER_TYPE_FRONTMATTER_FIELDS (defaults) + the vault's page-types.yaml
// extensions[].frontmatter_extras (consumed in domeDoctor).
const UNIVERSAL_FRONTMATTER_FIELDS: ReadonlyArray<string> = ["type", "created", "updated", "sources"];

// Per-type optional frontmatter fields for the four DEFAULT page types per
// page-schema.md §"Page-type-specific extensions". Vault-declared extension
// types (`spec`, `invariant`, `matrix`, `gotcha`, …) bring their own fields
// via .dome/page-types.yaml `extensions[].frontmatter_extras`; doctor reads
// those at runtime.
const PER_TYPE_FRONTMATTER_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  entity: ["aliases", "tags"],
  concept: ["aliases", "tags", "status"],
  source: ["url", "author", "external"],
  synthesis: ["status", "supersedes"],
};

// Pluralized wiki subdirectory -> singular page type (per PAGE_TYPE_BY_DIRECTORY).
// Delegated to the canonical page-type module so doctor and writeDocument stay
// in lockstep on plural/singular derivation.
const expectedPageTypeForDir = (dirName: string): string => singularOf(dirName);

// Iterates every .md file in wiki/, yielding (subdir, filename, relPath).
async function* walkWikiPages(vault: Vault): AsyncGenerator<{ subdir: string; filename: string; rel: string }> {
  const wikiRoot = join(vault.path, "wiki");
  if (!existsSync(wikiRoot)) return;
  const subdirs = await readdir(wikiRoot, { withFileTypes: true });
  for (const subdir of subdirs) {
    if (!subdir.isDirectory()) continue;
    const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      yield { subdir: subdir.name, filename: f.name, rel: `wiki/${subdir.name}/${f.name}` };
    }
  }
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

  const wikiRoot = join(vault.path, "wiki");

  // Page-type catalogue: dirs that are legitimate per the vault's page-type
  // config. Used for short-form wikilink resolution and unknown-dir checks.
  const knownPluralDirs = new Set<string>([
    ...vault.pageTypes.defaults.map(t => pluralOf(t)),
    ...vault.pageTypes.extensions.map(e => pluralOf(typeof e === "string" ? e : e.name)),
  ]);
  // Always-allowed structural directories under wiki/ even if no pages of that
  // type exist yet. invariants/, specs/, gotchas/ ship as documentation
  // surfaces in the dogfooded Dome vault itself.
  for (const d of ["invariants", "specs", "gotchas"]) knownPluralDirs.add(d);

  // Track which extension page-types are actually used (for the "unused
  // extensions" check).
  const usedExtensionTypes = new Set<string>();
  const declaredExtensionTypes = new Set<string>(
    vault.pageTypes.extensions.map(e => typeof e === "string" ? e : e.name)
  );
  // Build the per-type frontmatter field catalogue from defaults + vault's
  // extensions[].frontmatter_extras. Extensions in short-form (just a name)
  // contribute no extras — doctor flags only fields outside the union.
  const perTypeFields: Record<string, ReadonlyArray<string>> = { ...PER_TYPE_FRONTMATTER_FIELDS };
  for (const ext of vault.pageTypes.extensions) {
    if (typeof ext === "string") {
      perTypeFields[ext] = perTypeFields[ext] ?? [];
      continue;
    }
    const extras = ext.frontmatter_extras;
    perTypeFields[ext.name] = extras !== undefined ? Object.keys(extras) : [];
  }

  // Walk every wiki page once and run all per-page checks together.
  for await (const { subdir, rel } of walkWikiPages(vault)) {
    // Track which extension types are used.
    if (declaredExtensionTypes.has(expectedPageTypeForDir(subdir))) {
      usedExtensionTypes.add(expectedPageTypeForDir(subdir));
    }

    const out = await vault.tools.readDocument({ path: rel });
    if (!out.result.ok) continue;
    const doc = out.result.value;

    // CHECK 1 (existing): frontmatter type matches directory.
    const expectedType = expectedPageTypeForDir(subdir);
    if (doc.frontmatter.type && doc.frontmatter.type !== expectedType) {
      violations.push(`${rel}: frontmatter type=${doc.frontmatter.type} does not match directory ${subdir}`);
    }

    // CHECK 2 (new): short-form wikilinks (violates WIKILINKS_ARE_FULLPATH).
    // CHECK 3 (new): full-path wikilinks pointing to missing files.
    const links = parseWikilinks(doc.body);
    for (const link of links) {
      if (!link.isFullPath) {
        violations.push(`${rel}: short-form wikilink "${link.target}" (WIKILINKS_ARE_FULLPATH)`);
      } else {
        // Treat the target as a path relative to vault root; add .md if missing.
        const targetPath = link.target.endsWith(".md") ? link.target : `${link.target}.md`;
        const absTarget = join(vault.path, targetPath);
        if (!existsSync(absTarget)) {
          violations.push(`${rel}: unresolved wikilink "${link.target}"`);
        }
      }
    }

    // CHECK 4 (new): frontmatter fields outside the known per-type schema.
    // Per page-schema.md §"Extension types" line 125: "Unknown fields trigger
    // a soft warning (logged to log.md) but not a rejection". Doctor surfaces
    // them as info, not as exit-code-affecting violations.
    const docType = doc.frontmatter.type;
    if (typeof docType === "string") {
      const allowed = new Set<string>([
        ...UNIVERSAL_FRONTMATTER_FIELDS,
        ...(perTypeFields[docType] ?? []),
      ]);
      for (const key of Object.keys(doc.frontmatter)) {
        if (!allowed.has(key)) {
          info.push(`${rel}: unknown frontmatter field "${key}" for type=${docType} (soft warning per page-schema.md)`);
        }
      }
    }
  }

  // CHECK 5 (new): unknown wiki subdirectories (not in page-types config).
  if (existsSync(wikiRoot)) {
    const subdirs = await readdir(wikiRoot, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      if (!knownPluralDirs.has(subdir.name)) {
        violations.push(`wiki/${subdir.name}/: unknown wiki subdirectory (not in page-types config)`);
      }
    }
  }

  // CHECK 6 (new): raw files modified after creation (heuristic for
  // RAW_IS_IMMUTABLE violations that bypassed the Tool boundary).
  const rawRoot = join(vault.path, "raw");
  if (existsSync(rawRoot)) {
    for await (const filePath of walkMd(rawRoot)) {
      const st = await stat(filePath);
      // birthtime is unreliable on Linux ext4 (returns 0); guard with > 0.
      if (st.birthtimeMs > 0 && st.mtimeMs > st.birthtimeMs + 1000) {
        const rel = filePath.slice(vault.path.length + 1);
        violations.push(`${rel}: raw file modified after creation (RAW_IS_IMMUTABLE; mtime>${(st.mtimeMs - st.birthtimeMs).toFixed(0)}ms past ctime)`);
      }
    }
  }

  // CHECK 7 (new): log.md timestamps must be monotonically non-decreasing.
  const logPath = join(vault.path, "log.md");
  if (existsSync(logPath)) {
    const logText = await Bun.file(logPath).text();
    const tsRe = /^## \[([^\]]+)\]/gm;
    let prev: string | null = null;
    let lineNo = 0;
    for (const match of logText.matchAll(tsRe)) {
      lineNo++;
      const ts = match[1]!;
      if (prev !== null && ts < prev) {
        violations.push(`log.md: non-monotonic timestamp at entry #${lineNo}: ${ts} < ${prev}`);
      }
      prev = ts;
    }
  }

  // CHECK 8 (new): unused page-type extensions (declared in page-types.yaml
  // but no page actually uses them — best-effort hint, info-only).
  for (const ext of declaredExtensionTypes) {
    if (!usedExtensionTypes.has(ext)) {
      info.push(`page-type extension "${ext}" declared but no page uses it`);
    }
  }

  // CHECK 9 (new): INBOX_IS_EPHEMERAL fallback — files in inbox/<bucket>/
  // (excluding inbox/review/, which is a destination not an intake) that
  // have aged past hooks.inbox_stale_age_hours emit a violation. Per
  // docs/wiki/invariants/INBOX_IS_EPHEMERAL.md §"Structural enforcement".
  const inboxRoot = join(vault.path, "inbox");
  if (existsSync(inboxRoot)) {
    const thresholdMs = vault.config.hooks.inbox_stale_age_hours * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;
    const buckets = await readdir(inboxRoot, { withFileTypes: true });
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      // inbox/review/ is a destination for SENSITIVE_GOES_TO_INBOX, not an
      // intake — exclude unconditionally per INBOX_IS_EPHEMERAL.md.
      if (bucket.name === "review") continue;
      const bucketDir = join(inboxRoot, bucket.name);
      const files = await readdir(bucketDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const filePath = join(bucketDir, f.name);
        const st = await stat(filePath);
        if (st.mtimeMs < cutoff) {
          const ageHours = ((Date.now() - st.mtimeMs) / (60 * 60 * 1000)).toFixed(1);
          violations.push(
            `inbox/${bucket.name}/${f.name}: stale (${ageHours}h old, threshold ${vault.config.hooks.inbox_stale_age_hours}h) — INBOX_IS_EPHEMERAL`,
          );
        }
      }
    }
  }

  // --rebuild-index: delegate to the SDK primitive. Privileged-writer is
  // internal; the CLI consumes the public `vault.rebuildIndex` seam.
  if (opts.rebuildIndex) {
    await vault.rebuildIndex();
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
  if (opts.drainHooks) {
    await vault.drainHooks();
    info.push(`--drain-hooks: drained (async hook queue is now idle)`);
  }
  if (opts.resetQuarantinedHooks) {
    const { makeQuarantineStore } = await import("../../quarantine-store");
    const store = makeQuarantineStore(join(vault.path, ".dome", "state", "quarantined.json"));
    const before = await store.load();
    await store.clear();
    info.push(`--reset-quarantined-hooks: cleared (${before.length} handler(s) were quarantined)`);
  }
  if (opts.showRecentHookCycles) {
    const logPath3 = join(vault.path, "log.md");
    if (existsSync(logPath3)) {
      const logText = await Bun.file(logPath3).text();
      const cycleRe = /^## \[([^\]]+)\] hook\.cycle-detected \| (.+)$/gm;
      const cycles: { ts: string; detail: string }[] = [];
      for (const m of logText.matchAll(cycleRe)) {
        cycles.push({ ts: m[1]!, detail: m[2]! });
      }
      if (cycles.length === 0) {
        info.push("hook-cycle: (none)");
      } else {
        for (const c of cycles) {
          info.push(`hook-cycle: [${c.ts}] ${c.detail}`);
        }
      }
    } else {
      info.push("hook-cycle: (log.md not present)");
    }
  }
  if (opts.showReviewQueue) {
    const reviewDir = join(vault.path, "inbox", "review");
    if (existsSync(reviewDir)) {
      const items = await readdir(reviewDir, { withFileTypes: true });
      const files = items.filter(e => e.isFile()).map(e => e.name).sort();
      if (files.length === 0) {
        info.push("review-queue: (empty)");
      } else {
        for (const name of files) {
          const st = await stat(join(reviewDir, name));
          info.push(`review-queue: inbox/review/${name} (mtime ${new Date(st.mtimeMs).toISOString()})`);
        }
      }
    } else {
      info.push("review-queue: (inbox/review/ not present; SENSITIVE_GOES_TO_INBOX likely disabled)");
    }
  }
  if (opts.showRawCitations) {
    // Walk wiki pages; for each `sources:` frontmatter entry whose link points
    // under raw/, accumulate (raw target -> [wiki page paths]).
    const citations: Map<string, string[]> = new Map();
    for await (const { rel } of walkWikiPages(vault)) {
      const out = await vault.tools.readDocument({ path: rel });
      if (!out.result.ok) continue;
      const sources = out.result.value.frontmatter.sources;
      if (!Array.isArray(sources)) continue;
      for (const s of sources) {
        if (typeof s !== "string") continue;
        const m = s.match(/^\[\[(raw\/[^\]]+)\]\]$/);
        if (!m) continue;
        const target = m[1]!;
        const list = citations.get(target) ?? [];
        list.push(rel);
        citations.set(target, list);
      }
    }
    if (citations.size === 0) {
      info.push("raw-citation: (no wiki pages cite any raw/ source)");
    } else {
      for (const [target, citers] of [...citations.entries()].sort()) {
        info.push(`raw-citation: ${target} <- [${citers.sort().join(", ")}]`);
      }
    }
  }
  if (opts.recentActivityN !== undefined) {
    const limit = opts.recentActivityN ?? 50;
    const logPath2 = join(vault.path, "log.md");
    if (existsSync(logPath2)) {
      const logText = await Bun.file(logPath2).text();
      const re = /^## \[([^\]]+)\] (\S+) \| (.+)$/gm;
      const entries: { ts: string; verb: string; subject: string }[] = [];
      for (const m of logText.matchAll(re)) {
        entries.push({ ts: m[1]!, verb: m[2]!, subject: m[3]! });
      }
      const tail = entries.slice(-limit);
      for (const e of tail) {
        info.push(`recent: [${e.ts}] ${e.verb} | ${e.subject}`);
      }
    }
  }

  if (opts.repair) {
    const { buildAgentsMdTemplated, mergeAgentsMd, buildInitialAgentsMd } = await import("../../agents-md");
    const agentsPath = join(vault.path, "AGENTS.md");
    const newTemplated = buildAgentsMdTemplated(vault.config, vault.pageTypes, [...WORKFLOW_NAMES]);
    if (existsSync(agentsPath)) {
      const existing = await Bun.file(agentsPath).text();
      const merged = mergeAgentsMd(existing, newTemplated);
      await Bun.write(agentsPath, merged);
      info.push("--repair: AGENTS.md templated sections regenerated (user-prose preserved)");
    } else {
      const fresh = buildInitialAgentsMd(vault.config, vault.pageTypes, [...WORKFLOW_NAMES]);
      await Bun.write(agentsPath, fresh);
      info.push("--repair: AGENTS.md created (was missing)");
    }
  }

  if (opts.timeSinceReconcile) {
    const reconcilePath = join(vault.path, ".dome", "state", "last-reconciled-sha.txt");
    if (!existsSync(reconcilePath)) {
      info.push("time-since-reconcile: never (dome reconcile has never run)");
    } else {
      const st = await stat(reconcilePath);
      const ageMs = Date.now() - st.mtimeMs;
      info.push(`time-since-reconcile: ${formatAge(ageMs)} (since ${new Date(st.mtimeMs).toISOString()})`);
    }
  }

  return ok({ exitCode: violations.length === 0 ? 0 : 1, violations, info });
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} seconds`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} minutes`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hours`;
  return `${Math.floor(ms / 86_400_000)} days`;
}
