import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { openVault, type Vault } from "../../vault";
import { ok, type Result, type ToolError } from "../../types";
import { walkMd } from "../../vault-fs";
import { parseWikilinks } from "../../wikilinks";
import { singularOf } from "../../page-type";
import { log as gitLog } from "../../git";

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

export function renderDashboard(_stats: VaultStats): string {
  throw new Error("not implemented");
}

export function renderJson(_stats: VaultStats): string {
  throw new Error("not implemented");
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
