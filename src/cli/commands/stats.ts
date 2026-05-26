import { openVault, type Vault } from "../../vault";
import { ok, type Result, type ToolError } from "../../types";

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

export async function collectStats(_vault: Vault): Promise<VaultStats> {
  throw new Error("not implemented");
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
