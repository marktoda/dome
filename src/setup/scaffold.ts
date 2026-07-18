import { parse as parseYaml } from "yaml";

import {
  canonicalContentScopeSchema,
  defineContentScope,
  type ContentScopeConfig,
} from "../core/content-scope";

const defaultScope = defineContentScope({
  version: 1,
  include: ["**/*.md"],
  exclude: [".dome/**", ".git/**"],
});
if (!defaultScope.ok) throw new Error("the shipped setup content scope is invalid");

/** Broad visible-owner-Markdown policy proposed by the first setup slice. */
export const DEFAULT_SETUP_CONTENT_SCOPE: ContentScopeConfig = defaultScope.scope;

/** Render one canonical persisted scope into an otherwise complete config. */
export function renderSetupVaultConfig(baseConfig: string, input: ContentScopeConfig): string {
  const scope = canonicalContentScopeSchema.parse(input);
  const base = parseConfigRecord(baseConfig, "base Dome config");
  if (Object.hasOwn(base, "content_scope")) {
    throw new Error("base Dome config already defines content_scope");
  }
  const lines = [
    baseConfig.trimEnd(),
    "",
    "# Dome setup: canonical owner-Markdown universe.",
    "content_scope:",
    `  version: ${scope.version}`,
    "  include:",
    ...scope.include.map((glob) => `    - ${JSON.stringify(glob)}`),
    "  exclude:",
    ...scope.exclude.map((glob) => `    - ${JSON.stringify(glob)}`),
    "",
  ];
  const rendered = lines.join("\n");
  const persisted = canonicalContentScopeSchema.parse(
    parseConfigRecord(rendered, "rendered Dome config").content_scope,
  );
  if (!sameScope(persisted, scope)) {
    throw new Error("rendered Dome config does not preserve the canonical content scope");
  }
  return rendered;
}

function parseConfigRecord(body: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = parseYaml(body); }
  catch { throw new Error(`${label} is invalid YAML`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function sameScope(left: ContentScopeConfig, right: ContentScopeConfig): boolean {
  return left.version === right.version &&
    arraysEqual(left.include, right.include) && arraysEqual(left.exclude, right.exclude);
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
