// cli/commands/stale-claims: wrapper for the dome.claims.stale-claims view.
//
// `dome audit stale-claims` lists every claim whose `*(as of)*` date is older
// than the configured horizon (`stale_claims_horizon_days`, default 120) —
// the claims loop's "coherence over time" instrument, filed under the
// `dome audit` umbrella (cohesion review 2026-07-06; formerly the top-level
// `dome stale-claims`). See docs/wiki/specs/claims.md and
// docs/wiki/specs/cli.md §"`dome audit`".

import { runNamedViewCommand } from "../named-view-command";
import { bullets, headline, resolveCaps, section } from "../presenter";

export type StaleClaimsCommandOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export type StaleClaimRow = {
  readonly path: string;
  readonly key: string;
  readonly value: string;
  readonly asOf: string;
  readonly daysStale: number;
};

export type StaleClaimsData = {
  readonly horizonDays: number;
  readonly staleClaims: ReadonlyArray<StaleClaimRow>;
};

export async function runStaleClaims(
  options: StaleClaimsCommandOptions = {},
): Promise<number> {
  return runNamedViewCommand({
    commandLabel: "dome audit stale-claims",
    commandName: "stale-claims",
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    failedError: "stale-claims-failed",
    renderHuman: (data) => renderStaleClaimsText(data as StaleClaimsData),
  });
}

export function renderStaleClaimsText(data: StaleClaimsData): string {
  const caps = resolveCaps();
  const n = data.staleClaims.length;
  const lines: string[] = [
    headline(
      { cmd: "stale-claims" },
      n === 0
        ? { tone: "ok", label: `pass — 0 stale, horizon ${data.horizonDays}d` }
        : { tone: "warn", label: `${n} stale, horizon ${data.horizonDays}d` },
      caps,
    ),
  ];

  if (n > 0) {
    lines.push(
      ...section(
        "Stale claims",
        bullets(
          data.staleClaims.map((c) =>
            `${c.path} — **${c.key}:** ${c.value} *(as of ${c.asOf}, ${c.daysStale}d stale)*`
          ),
          caps,
        ),
        caps,
      ),
    );
  }

  return lines.join("\n");
}
