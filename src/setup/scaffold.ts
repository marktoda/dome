import { parse as parseYaml } from "yaml";

import {
  canonicalContentScopeSchema,
  DEFAULT_CONTENT_SCOPE_CONFIG,
  renderContentScopeYaml,
  type ContentScopeConfig,
} from "../core/content-scope";

/** Broad visible-owner-Markdown policy proposed by the first setup slice. */
export const DEFAULT_SETUP_CONTENT_SCOPE = DEFAULT_CONTENT_SCOPE_CONFIG;

/** Exact managed mapping inserted into an existing config that has no scope. */
export function renderSetupContentScopeConfig(input: ContentScopeConfig): string {
  const scope = canonicalContentScopeSchema.parse(input);
  const rendered = "# Dome setup: canonical owner-Markdown universe.\n" + renderContentScopeYaml(scope);
  const decoded = parseYaml(rendered) as unknown;
  const persisted = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>).content_scope
    : undefined;
  canonicalContentScopeSchema.parse(persisted);
  return rendered;
}
