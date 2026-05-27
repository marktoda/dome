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
    // Priority order: vault-local → bundle → SDK builtin. Bundles slot between
    // vault-local (highest precedence) and SDK shipped defaults so bundle
    // contributions can override built-ins but a vault-local override of a
    // bundle name still wins. See docs/wiki/specs/sdk-surface.md
    // §"Extension bundles".
    const localPath = join(this.vault.path, ".dome", "prompts", `${name}.md`);
    if (existsSync(localPath)) {
      return this.loadFrom(name, localPath, PromptSource.VaultLocal);
    }

    const bundles = this.vault.bundles ?? [];
    for (const bundle of bundles) {
      for (const workflowPath of bundle.workflowPaths) {
        if (basename(workflowPath) === `${name}.md`) {
          // Bundles are vault-local in v0.5; PromptSource.VaultLocal is the
          // closest analogue. A dedicated `Bundle` source arrives with the
          // SDK-level surface fixture in v0.5.1.
          return this.loadFrom(name, workflowPath, PromptSource.VaultLocal);
        }
      }
    }

    const builtinPath = join(BUILTIN_DIR, `${name}.md`);
    if (existsSync(builtinPath)) {
      return this.loadFrom(name, builtinPath, PromptSource.Sdk);
    }

    return null;
  }

  private async loadFrom(
    name: string,
    path: string,
    source: PromptSource,
  ): Promise<LoadedPrompt> {
    const text = await readFile(path, "utf8");
    const parsed = parseFrontmatter(text);
    const includesResolved = await this.resolveIncludes(parsed.body, 0);
    const resolvedBody = this.substituteVariables(includesResolved);
    const wfParse = parseWorkflowFrontmatter(parsed.frontmatter);
    return {
      name,
      source,
      body: resolvedBody,
      frontmatter: parsed.frontmatter,
      workflow: wfParse.ok ? wfParse.value : null,
    };
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
    // Bundle workflows surface in list() so MCP renderers and `dome` CLI
    // introspection see bundle-contributed prompts alongside built-ins.
    const bundles = this.vault.bundles ?? [];
    for (const bundle of bundles) {
      for (const workflowPath of bundle.workflowPaths) {
        const fname = basename(workflowPath);
        if (fname.endsWith(".md")) names.add(basename(fname, ".md"));
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

  // Substitute the closed set of `{{vault.*}}` template variables. Runs AFTER
  // include resolution, so a partial may itself reference `{{vault.path}}` and
  // get substituted in the surrounding workflow's render. Substrate:
  // docs/wiki/specs/prompts-and-workflows.md §"Vault augmentation slots" and
  // docs/wiki/invariants/WORKFLOWS_KNOW_VAULT_CONTEXT.md.
  //
  // The variable set is intentionally tiny — adding new variables is a
  // deliberate substrate change, not an ad-hoc extension. The migrate.md
  // scar (literal `<path>` was prose, not a variable) is structurally
  // prevented because only the explicit `{{vault.path}}` form is recognized.
  private substituteVariables(body: string): string {
    return body.replace(/\{\{vault\.path\}\}/g, this.vault.path);
  }
}
