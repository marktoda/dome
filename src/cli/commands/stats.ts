import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { openVault, type Vault } from "../../vault";
import { ok, type Result, type ToolError } from "../../types";
import { walkMd } from "../../vault-fs";
import { parseWikilinks } from "../../wikilinks";
import { singularOf } from "../../page-type";
import { log as gitLog } from "../../git";
import pc from "picocolors";

export interface VaultStats {
  vaultPath: string;
  pageCounts: Record<string, number>;
  totalPages: number;
  wikilinks: { total: number; orphans: number };
  raw: { count: number; bytes: number };
  notes: { count: number };
  log: { entries: number; lastWriteAt: string | null };
  topHubs: Array<{ target: string; incoming: number }>;
  git: { ageDays: number | null; commits: number; contributors: number };
}

export interface DomeStatsOpts {
  json?: boolean;
}

export async function collectStats(vault: Vault): Promise<VaultStats> {
  const stats: VaultStats = {
    vaultPath: vault.path,
    pageCounts: {},
    totalPages: 0,
    wikilinks: { total: 0, orphans: 0 },
    raw: { count: 0, bytes: 0 },
    notes: { count: 0 },
    log: { entries: 0, lastWriteAt: null },
    topHubs: [],
    git: { ageDays: null, commits: 0, contributors: 0 },
  };

  // Wiki walk: pages, wikilinks, top hubs.
  const wikiRoot = join(vault.path, "wiki");
  const hubCounts = new Map<string, number>();
  if (existsSync(wikiRoot)) {
    const subdirs = await readdir(wikiRoot, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      const type = singularOf(subdir.name);
      const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        stats.totalPages++;
        stats.pageCounts[type] = (stats.pageCounts[type] ?? 0) + 1;

        const rel = `wiki/${subdir.name}/${f.name}`;
        const out = await vault.tools.readDocument({ path: rel });
        if (!out.result.ok) continue;
        const body = out.result.value.body;
        for (const link of parseWikilinks(body)) {
          stats.wikilinks.total++;
          if (!link.isFullPath) continue;
          const targetRel = link.target.endsWith(".md") ? link.target : `${link.target}.md`;
          const absTarget = join(vault.path, targetRel);
          if (!existsSync(absTarget)) {
            stats.wikilinks.orphans++;
            continue;
          }
          hubCounts.set(targetRel, (hubCounts.get(targetRel) ?? 0) + 1);
        }
      }
    }
  }

  // Top 5 hubs by incoming count.
  stats.topHubs = [...hubCounts.entries()]
    .map(([target, incoming]) => ({ target, incoming }))
    .sort((a, b) => b.incoming - a.incoming)
    .slice(0, 5);

  // Raw files: count + total bytes.
  const rawRoot = join(vault.path, "raw");
  if (existsSync(rawRoot)) {
    for await (const p of walkMd(rawRoot)) {
      const s = await stat(p);
      stats.raw.count++;
      stats.raw.bytes += s.size;
    }
  }

  // Notes files: count only.
  const notesRoot = join(vault.path, "notes");
  if (existsSync(notesRoot)) {
    for await (const _p of walkMd(notesRoot)) {
      stats.notes.count++;
    }
  }

  // log.md: count `## [<ts>]` headings and capture the most recent timestamp.
  // Same regex doctor uses for check 7 (log monotonicity).
  const logPath = join(vault.path, "log.md");
  if (existsSync(logPath)) {
    const logText = await Bun.file(logPath).text();
    const tsRe = /^## \[([^\]]+)\]/gm;
    let last: string | null = null;
    for (const m of logText.matchAll(tsRe)) {
      stats.log.entries++;
      const ts = m[1]!;
      if (last === null || ts > last) last = ts;
    }
    stats.log.lastWriteAt = last;
  }

  // Git: walk log() from HEAD. In the dogfood case (vault is a subdirectory
  // of an outer git repo), isomorphic-git walks the outer repo's history —
  // commit/contributor counts reflect the outer repo. Acceptable for v1.
  try {
    const commits = await gitLog({ path: vault.path });
    stats.git.commits = commits.length;
    if (commits.length > 0) {
      const oldest = commits[commits.length - 1]!;
      const firstCommitTsSec = oldest.commit.committer.timestamp;
      const firstCommitMs = firstCommitTsSec * 1000;
      stats.git.ageDays = Math.floor((Date.now() - firstCommitMs) / (24 * 60 * 60 * 1000));
      const authors = new Set<string>();
      for (const c of commits) {
        const a = c.commit.author;
        authors.add(a.email !== "" ? a.email : a.name);
      }
      stats.git.contributors = authors.size;
    }
  } catch {
    // No git repo or read error — leave defaults (ageDays=null, commits=0, contributors=0).
  }

  return stats;
}

// Cells in each bar.
const BAR_WIDTH = 12;

function bar(filledFrac: number, fillColor: (s: string) => string): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(filledFrac * BAR_WIDTH)));
  const empty = BAR_WIDTH - filled;
  return fillColor("▓".repeat(filled)) + pc.dim("░".repeat(empty));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// Map a page-type singular to its plural label for display.
function pluralLabel(typeName: string, n: number): string {
  // Special-case the four shipped types + common substrate extensions whose
  // English plurals aren't a simple "+s".
  const overrides: Record<string, string> = {
    entity: "entities",
    matrix: "matrices",
    synthesis: "syntheses",
    gotcha: "gotchas",
  };
  const label = overrides[typeName] ?? `${typeName}s`;
  return n === 1 ? typeName : label;
}

export function renderDashboard(stats: VaultStats): string {
  const headline = pc.bold(pc.cyan("DOME")) + " · " + pc.dim(stats.vaultPath);
  const divider = pc.dim("─".repeat(45));

  const countParts: string[] = [pc.bold(pc.yellow(String(stats.totalPages))) + " pages"];
  // Sort types by count desc; show non-zero ones inline.
  const sortedTypes = Object.entries(stats.pageCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5); // top 5 types
  for (const [type, n] of sortedTypes) {
    countParts.push(pc.bold(pc.yellow(String(n))) + " " + pluralLabel(type, n));
  }
  const countLine = "  " + countParts.join("  ·  ");

  // Bar denominators are heuristics — bars are texture, not precise.
  const wikiDenom = Math.max(1, stats.totalPages * 10);
  const wikiFrac = stats.wikilinks.total / wikiDenom;
  const rawDenom = Math.max(1, stats.raw.count + stats.totalPages);
  const rawFrac = stats.raw.count / rawDenom;
  const logFrac = stats.log.entries === 0 ? 0 : Math.min(1, stats.log.entries / 50);

  const wikiLine =
    "  Wikilinks  " + bar(wikiFrac, pc.green) + "  " +
    `${stats.wikilinks.total} links` +
    (stats.wikilinks.orphans > 0 ? ` · ${pc.red(String(stats.wikilinks.orphans))} orphans` : "");

  const rawLine =
    "  Raw files  " + bar(rawFrac, pc.yellow) + "  " +
    `${stats.raw.count} sources · ${formatBytes(stats.raw.bytes)}`;

  const logLastBit = stats.log.lastWriteAt !== null ? ` · last: ${formatAgo(stats.log.lastWriteAt)}` : "";
  const logLine =
    "  Log        " + bar(logFrac, pc.cyan) + "  " +
    `${stats.log.entries} entries${logLastBit}`;

  const topHubsBit = stats.topHubs.slice(0, 3)
    .map(h => {
      // Strip the wiki/<type>/ prefix and .md suffix for display.
      const trimmed = h.target.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "");
      return `${trimmed} (${h.incoming})`;
    })
    .join(" · ");
  const topHubsLine = stats.topHubs.length > 0 ? `  Top hubs:  ${topHubsBit}` : null;

  const ageBit = stats.git.ageDays !== null ? `${stats.git.ageDays} days` : "?";
  const vaultAgeLine =
    `  Vault age: ${ageBit} · ${stats.git.commits} commits · ${stats.git.contributors} contributors`;

  const notesLine = stats.notes.count > 0
    ? `  Notes:     ${stats.notes.count} files`
    : null;

  return [
    "",
    headline,
    "  " + divider,
    countLine,
    "",
    wikiLine,
    rawLine,
    logLine,
    notesLine,
    "",
    topHubsLine,
    vaultAgeLine,
    "",
  ].filter(l => l !== null).join("\n");
}

export function renderJson(stats: VaultStats): string {
  return JSON.stringify(stats, null, 2);
}

export async function domeStats(
  vaultPath: string,
  opts: DomeStatsOpts,
): Promise<Result<{ output: string }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const stats = await collectStats(res.value);
  const output = opts.json === true ? renderJson(stats) : renderDashboard(stats);
  return ok({ output });
}
