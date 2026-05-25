import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError } from "./types";
import { isGitRepo } from "./git";
import { makeDispatcher, type Dispatcher } from "./dispatcher";
import { readDocument, type ReadDocumentInput } from "./tools/read-document";
import { writeDocument, type WriteDocumentInput } from "./tools/write-document";
import { appendLog, type AppendLogInput } from "./tools/append-log";
import { searchIndex, type SearchIndexInput } from "./tools/search-index";
import { wikilinkResolve, type WikilinkResolveInput } from "./tools/wikilink-resolve";
import { moveDocument, type MoveDocumentInput } from "./tools/move-document";
import { deleteDocument, type DeleteDocumentInput } from "./tools/delete-document";

export interface VaultConfig {
  invariants: Record<string, "enabled" | "disabled">;
  hooks: {
    builtin: Record<string, "enabled" | "disabled">;
    max_causation_depth: number;
  };
  git: {
    auto_commit_workflows: boolean;
  };
}

export interface PageTypesConfig {
  defaults: ReadonlyArray<string>;
  extensions: ReadonlyArray<string | { name: string; frontmatter_extras?: Record<string, unknown> }>;
}

export interface BoundToolSurface {
  readDocument: (input: ReadDocumentInput) => ReturnType<typeof readDocument>;
  writeDocument: (input: WriteDocumentInput) => ReturnType<typeof writeDocument>;
  appendLog: (input: AppendLogInput) => ReturnType<typeof appendLog>;
  searchIndex: (input: SearchIndexInput) => ReturnType<typeof searchIndex>;
  wikilinkResolve: (input: WikilinkResolveInput) => ReturnType<typeof wikilinkResolve>;
  moveDocument: (input: MoveDocumentInput) => ReturnType<typeof moveDocument>;
  deleteDocument: (input: DeleteDocumentInput) => ReturnType<typeof deleteDocument>;
}

export interface Vault {
  readonly path: string;
  readonly config: VaultConfig;
  readonly pageTypes: PageTypesConfig;
  readonly dispatcher: Dispatcher;
  readonly tools: BoundToolSurface;
}

async function findVaultRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".dome", "config.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const DEFAULT_PAGE_TYPES: PageTypesConfig = {
  defaults: ["entity", "concept", "source", "synthesis"],
  extensions: [],
};

const DEFAULT_CONFIG: VaultConfig = {
  invariants: {
    EVERY_WRITE_IS_LOGGED: "enabled",
    PAGE_TYPE_BY_DIRECTORY: "enabled",
    WIKILINKS_ARE_FULLPATH: "enabled",
    INBOX_IS_EPHEMERAL: "enabled",
    SENSITIVE_GOES_TO_INBOX: "disabled",
    PAGE_CREATION_REQUIRES_RECURRENCE: "disabled",
  },
  hooks: {
    builtin: { "auto-update-index": "enabled", "auto-cross-reference": "enabled" },
    max_causation_depth: 50,
  },
  git: { auto_commit_workflows: true },
};

export async function openVault(path: string): Promise<Result<Vault, ToolError>> {
  const root = await findVaultRoot(path);
  if (root === null) {
    return err({ kind: "config-invalid", message: `No .dome/config.yaml found at or above ${path}` });
  }
  if (!(await isGitRepo(root))) {
    return err({ kind: "vault-not-git-repo", path: root });
  }
  let config: VaultConfig = DEFAULT_CONFIG;
  let pageTypes: PageTypesConfig = DEFAULT_PAGE_TYPES;
  try {
    const cfgText = await readFile(join(root, ".dome", "config.yaml"), "utf8");
    const parsed = parseYaml(cfgText) as Partial<VaultConfig>;
    config = { ...DEFAULT_CONFIG, ...parsed,
      invariants: { ...DEFAULT_CONFIG.invariants, ...(parsed.invariants ?? {}) },
      hooks: { ...DEFAULT_CONFIG.hooks, ...(parsed.hooks ?? {}),
        builtin: { ...DEFAULT_CONFIG.hooks.builtin, ...((parsed.hooks?.builtin) ?? {}) } },
      git: { ...DEFAULT_CONFIG.git, ...(parsed.git ?? {}) },
    };
  } catch (e: unknown) {
    return err({ kind: "config-invalid", message: `Failed to parse .dome/config.yaml: ${(e as Error).message}` });
  }
  try {
    const ptText = await readFile(join(root, ".dome", "page-types.yaml"), "utf8");
    const parsed = parseYaml(ptText) as Partial<PageTypesConfig>;
    pageTypes = { ...DEFAULT_PAGE_TYPES, ...parsed };
  } catch {
    // page-types is optional
  }
  const dispatcher = makeDispatcher(root);
  const partial = { path: root, config, pageTypes, dispatcher } as Vault;
  const tools: BoundToolSurface = {
    readDocument: (input) => readDocument(partial, input),
    writeDocument: (input) => writeDocument(partial, dispatcher, input),
    appendLog: (input) => appendLog(partial, dispatcher, input),
    searchIndex: (input) => searchIndex(partial, input),
    wikilinkResolve: (input) => wikilinkResolve(partial, input),
    moveDocument: (input) => moveDocument(partial, dispatcher, input),
    deleteDocument: (input) => deleteDocument(partial, dispatcher, input),
  };
  return ok({ path: root, config, pageTypes, dispatcher, tools });
}
