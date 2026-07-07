// cli/commands/orphan-pages: wrapper for the dome.markdown.orphan-pages view.
//
// `dome audit orphan-pages` lists every markdown page with zero incoming
// wikilinks (and not implicitly linked from its root `index.md`), filed under
// the `dome audit` umbrella (cohesion review 2026-07-06; formerly the
// top-level `dome orphan-pages`). See docs/wiki/specs/cli.md
// §"`dome audit`".

import { runNamedViewCommand } from "../named-view-command";
import { bullets, headline, resolveCaps, section } from "../presenter";

export type OrphanPagesCommandOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export type OrphanPageRow = {
  readonly path: string;
  readonly incomingLinkCount: number;
  readonly reason: string;
};

export type OrphanPagesData = {
  readonly totalScanned: number;
  readonly totalOrphans: number;
  readonly orphans: ReadonlyArray<OrphanPageRow>;
};

export async function runOrphanPages(
  options: OrphanPagesCommandOptions = {},
): Promise<number> {
  return runNamedViewCommand({
    commandLabel: "dome audit orphan-pages",
    commandName: "orphan-pages",
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    failedError: "orphan-pages-failed",
    renderHuman: (data) => renderOrphanPagesText(data as OrphanPagesData),
  });
}

export function renderOrphanPagesText(data: OrphanPagesData): string {
  const caps = resolveCaps();
  const n = data.totalOrphans;
  const lines: string[] = [
    headline(
      { cmd: "orphan-pages" },
      n === 0
        ? { tone: "ok", label: `pass — ${data.totalScanned} pages scanned, 0 orphans` }
        : { tone: "warn", label: `${n} orphans of ${data.totalScanned} pages` },
      caps,
    ),
  ];

  if (n > 0) {
    lines.push(
      ...section(
        "Orphans",
        bullets(data.orphans.map((o) => o.path), caps),
        caps,
      ),
    );
  }

  return lines.join("\n");
}
