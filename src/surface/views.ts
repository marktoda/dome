// surface/views: protocol-neutral installed plugin-view discovery.

import type { InstalledView, Vault } from "../vault";

export const VIEWS_SCHEMA = "dome.views/v1";

export type ViewsDocument = {
  readonly schema: typeof VIEWS_SCHEMA;
  readonly count: number;
  readonly views: ReadonlyArray<InstalledView>;
};

export function collectViews(vault: Vault): ViewsDocument {
  const views = vault.listViews();
  return Object.freeze({
    schema: VIEWS_SCHEMA,
    count: views.length,
    views,
  });
}
