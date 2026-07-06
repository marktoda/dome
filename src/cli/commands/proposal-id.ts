// cli/commands/proposal-id: shared `<id>` argument parsing for `dome apply`
// and `dome reject`. A proposal id is always a non-negative integer (the
// `pending_proposals` table's AUTOINCREMENT primary key); anything else is a
// CLI-usage error the surface collectors never see.

/** Parse a CLI `<id>` argument into a proposal row id, or `null` when it is
 * not a bare non-negative integer. */
export function parseProposalId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
