// ledger/limits: normalize public query LIMIT inputs before SQL assembly.

const MAX_SQL_LIMIT = 1_000_000;

export function limitClause(limit: number | undefined): string {
  if (limit === undefined) return "";
  if (!Number.isFinite(limit)) return " LIMIT 0";
  const normalized = Math.trunc(limit);
  if (normalized <= 0) return " LIMIT 0";
  return ` LIMIT ${Math.min(normalized, MAX_SQL_LIMIT)}`;
}
