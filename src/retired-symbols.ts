// src/retired-symbols.ts
//
// Allow-list of retired symbol names. Consumed by the
// tests/integration/no-retired-symbol-names-in-specs.test.ts lockstep test
// (created in the next task) which walks docs/wiki/**/*.md and selected
// docs/cohesive/*.md, greps for these literals, and reports the file + line.
//
// See docs/wiki/linters/no-retired-symbol-names.md for the convention.

export const RETIRED_SYMBOLS = {
  ConsumerSurface: { replacedBy: "AbstractSurface", retiredAt: "Pass 2 → Pass 3 transition" },
  buildConsumerSurface: { replacedBy: "buildAbstractSurface(vault) + renderMcp(surface)", retiredAt: "Pass 2 → Pass 3 transition" },
  projectMcp: { replacedBy: "renderMcp(buildAbstractSurface(vault))", retiredAt: "Pass 2" },
  McpProjection: { replacedBy: "McpSurface (returned by renderMcp)", retiredAt: "Pass 2" },
  McpToolName: { replacedBy: "MCP_TOOL_NAMES (re-export from core)", retiredAt: "Pass 2" },
  SENSITIVE_GOES_TO_INBOX: { replacedBy: "(retired wholesale; sensitivity classification removed)", retiredAt: "Compiler-reframe merge" },
  sensitivity_classified: { replacedBy: "(no replacement; concept retired)", retiredAt: "Compiler-reframe merge" },
} as const;

export type RetiredSymbol = keyof typeof RETIRED_SYMBOLS;

export const RETIRED_SYMBOL_NAMES: ReadonlyArray<string> = Object.keys(RETIRED_SYMBOLS);
