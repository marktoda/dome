import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Vault } from "../vault";
import { parseFrontmatter } from "../frontmatter";
import { parseWorkflowFrontmatter, type WorkflowFrontmatter } from "./workflow-frontmatter";

export const PromptSource = {
  Sdk: "sdk",
  Plugin: "plugin",
  VaultLocal: "vault-local",
} as const;
export type PromptSource = typeof PromptSource[keyof typeof PromptSource];

export interface LoadedPrompt {
  name: string;
  source: PromptSource;
  body: string;
  frontmatter: Record<string, unknown>;
  workflow: WorkflowFrontmatter | null; // null if not a workflow-prompt
}

const BUILTIN_DIR = new URL("./builtin/", import.meta.url).pathname;

const MAX_INCLUDE_DEPTH = 8;

export class PromptLoader {
  constructor(private vault: Vault) {}

  async load(name: string): Promise<LoadedPrompt | null> {
    const sources: ReadonlyArray<[PromptSource, string]> = [
      [PromptSource.VaultLocal, join(this.vault.path, ".dome", "prompts", `${name}.md`)],
      [PromptSource.Sdk, join(BUILTIN_DIR, `${name}.md`)],
    ];
    for (const [source, path] of sources) {
      if (existsSync(path)) {
        const text = await readFile(path, "utf8");
        const parsed = parseFrontmatter(text);
        const resolvedBody = await this.resolveIncludes(parsed.body, 0);
        const wfParse = parseWorkflowFrontmatter(parsed.frontmatter);
        return {
          name,
          source,
          body: resolvedBody,
          frontmatter: parsed.frontmatter,
          workflow: wfParse.ok ? wfParse.value : null,
        };
      }
    }
    return null;
  }

  async list(): Promise<ReadonlyArray<string>> {
    const names = new Set<string>();
    const localDir = join(this.vault.path, ".dome", "prompts");
    if (existsSync(localDir)) {
      const entries = await readdir(localDir);
      for (const e of entries) {
        if (e.endsWith(".md")) names.add(basename(e, ".md"));
      }
    }
    if (existsSync(BUILTIN_DIR)) {
      const entries = await readdir(BUILTIN_DIR);
      for (const e of entries) {
        if (e.endsWith(".md")) names.add(basename(e, ".md"));
      }
    }
    return [...names].sort();
  }

  private async resolveIncludes(body: string, depth: number): Promise<string> {
    if (depth >= MAX_INCLUDE_DEPTH) return body;
    const includeRe = /\{\{include:\s*([^}]+?)\s*\}\}/g;
    let result = body;
    const matches = [...body.matchAll(includeRe)];
    for (const m of matches) {
      const includeName = m[1]!.replace(/\.md$/, "");
      const included = await this.load(includeName);
      const includedBody = included?.body ?? "";
      result = result.replace(m[0], includedBody);
    }
    return result;
  }
}
