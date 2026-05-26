// AbstractSurface — the protocol-agnostic four-kind aggregation every v1+
// consumer composes. Lives in @dome/sdk core (no LLM, no MCP dependency).
// Per-protocol renderers (renderMcp in @dome/sdk/mcp; future renderHttp /
// renderVoice in their companion entrypoints) consume this shape and project
// each kind to wire format.
//
// See docs/wiki/specs/sdk-surface.md §"Consumer surfaces" for the contract.
// See docs/wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND for why
// surface.tools is exactly vault.tools (one set of hook-dispatch-wrapped
// Tool entries per Vault, threaded through every renderer).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "./vault";
import type { BoundToolSurface } from "./hook-context";
import { PromptLoader } from "./prompts/prompt-loader";
import { WorkflowRegistry } from "./prompts/registry";
import { WorkflowTier, WORKFLOW_TIERS } from "./workflows/workflow-tier";

/**
 * Protocol-agnostic prompt descriptor. Carries a bare name (no protocol
 * prefix), an optional description, and the body that renders to messages.
 * Per-protocol renderers apply naming conventions (`dome.workflow.<name>`
 * for MCP, REST paths for HTTP, etc.).
 */
export interface PromptDescriptor {
  /** Bare name; no dome.workflow.* or dome.system_prompt prefix. */
  readonly name: string;
  readonly description: string;
  readonly body: string;
  /**
   * Workflow tier (Shipped default / Opt-in) so renderers can gate
   * visibility per-protocol. System prompts (no tier) use `undefined`.
   */
  readonly tier?: WorkflowTier;
}

/**
 * Protocol-agnostic resource descriptor. Carries a bare URI (no protocol
 * prefix), a logical name + description, a MIME type, and a read callback.
 * Per-protocol renderers apply URI conventions (`dome://` for MCP, REST
 * routes for HTTP).
 */
export interface ResourceDescriptor {
  /** Bare URI; no dome:// prefix. e.g. "index", "log", "vault/info". */
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  readonly read: () => Promise<string>;
}

/**
 * The protocol-agnostic four-kind aggregation. Every protocol renderer
 * (renderMcp today; future renderHttp / renderVoice) consumes this shape.
 */
export interface AbstractSurface {
  /** Identical to vault.tools — the BoundToolSurface threaded into every renderer. */
  readonly tools: BoundToolSurface;
  readonly prompts: ReadonlyArray<PromptDescriptor>;
  readonly resources: ReadonlyArray<ResourceDescriptor>;
  readonly instructions: string;
  /**
   * Dynamic resource lookup for path-keyed URIs (e.g., `page/<path>`).
   * Static URIs in `resources` are looked up first; this callback is the
   * fallback for URIs that aren't enumerated.
   *
   * **Static vs. dynamic — when to use which:** A URI belongs in
   * `resources` (the static descriptor list) when it is (a) enumerable —
   * `ResourceAdapter.list()` returns these — and (b) cheap to materialize
   * at surface-build time. A URI belongs in `readDynamicResource` when its
   * key-space is unbounded (every wiki page under `page/<path>`; future
   * `note/<id>`, `entity/<name>`) — eager enumeration would force I/O over
   * the whole vault at surface-build time, contradicting the synchronous
   * `renderMcp(surface)` projection. A URI that can be listed belongs in
   * `resources`; otherwise put it behind this callback.
   *
   * Returns null when the URI is unknown.
   */
  readonly readDynamicResource: (uri: string) => Promise<string | null>;
}

/**
 * Build the four-kind AbstractSurface for the vault. Constructs one
 * PromptLoader per call (shared between prompts-descriptor production and
 * instructions composition) so a v1+ long-running shell pays one filesystem
 * scan, not three.
 *
 * This is the single async factory consumers reach for the abstract layer.
 * The previous Phase B `buildConsumerSurface(vault)` (MCP-bound aggregation)
 * is replaced by `renderMcp(buildAbstractSurface(vault))` in
 * @dome/sdk/mcp's render-mcp.ts.
 */
export async function buildAbstractSurface(vault: Vault): Promise<AbstractSurface> {
  const loader = new PromptLoader(vault);
  const registry = new WorkflowRegistry(vault);

  const [prompts, instructions] = await Promise.all([
    buildPromptDescriptors(loader, registry),
    buildInstructionsString(vault, loader),
  ]);

  const resources = buildResourceDescriptors(vault);

  return {
    tools: vault.tools,
    prompts,
    resources,
    instructions,
    readDynamicResource: async (uri: string) => {
      // Page URIs: bare form is `page/<path>` (the MCP renderer prefixes
      // with `dome://`).
      const PAGE_PREFIX = "page/";
      if (uri.startsWith(PAGE_PREFIX)) {
        const path = uri.slice(PAGE_PREFIX.length);
        const out = await vault.tools.readDocument({ path });
        if (out.result.ok) return out.result.value.body;
      }
      return null;
    },
  };
}

async function buildPromptDescriptors(
  loader: PromptLoader,
  registry: WorkflowRegistry,
): Promise<PromptDescriptor[]> {
  const descriptors: PromptDescriptor[] = [];

  // system-base is the wiki-maintainer system prompt every harness loads at
  // session start. It's a system prompt (not a workflow), so it has no tier.
  const systemBase = await loader.load("system-base");
  if (systemBase) {
    descriptors.push({
      name: "system-base",
      description: "Wiki-maintainer system prompt; harnesses load at session start.",
      body: systemBase.body,
    });
  }

  const all = await registry.list();
  for (const def of all) {
    const tier = WORKFLOW_TIERS[def.name];
    const isShippedDefault = tier === WorkflowTier.ShippedDefault;
    const isOptInActivated = tier === WorkflowTier.OptIn && def.source === "vault-local";
    if (!isShippedDefault && !isOptInActivated) continue;
    descriptors.push({
      name: def.name,
      description: def.frontmatter.description ?? `The ${def.name} workflow.`,
      body: def.body,
      tier,
    });
  }
  return descriptors;
}

function buildResourceDescriptors(vault: Vault): ResourceDescriptor[] {
  return [
    {
      uri: "index",
      name: "Index",
      description: "The vault catalog (index.md)",
      mimeType: "text/markdown",
      read: () => readFile(join(vault.path, "index.md"), "utf8"),
    },
    {
      uri: "log",
      name: "Log",
      description: "Append-only operation log (log.md)",
      mimeType: "text/markdown",
      read: () => readFile(join(vault.path, "log.md"), "utf8"),
    },
    {
      uri: "vault/info",
      name: "Vault info",
      description: "Vault config + invariants + tiers",
      mimeType: "application/json",
      read: async () =>
        JSON.stringify(
          {
            path: vault.path,
            invariants: vault.config.invariants,
            pageTypes: vault.pageTypes,
          },
          null,
          2,
        ),
    },
  ];
}

async function buildInstructionsString(vault: Vault, loader: PromptLoader): Promise<string> {
  // Layering identical to the prior src/mcp/instructions-builder.ts. Sharing
  // the PromptLoader instance with buildPromptDescriptors above means the
  // .dome/prompts/ scan + system-base.md read happen once per surface build.
  const systemBase = await loader.load("system-base");
  const systemBaseBody = systemBase?.body ?? "";

  const enabledInvariants = Object.entries(vault.config.invariants)
    .filter(([, v]) => v === "enabled")
    .map(([k]) => `- ${k}`)
    .join("\n");

  const pageTypes = [
    ...vault.pageTypes.defaults,
    ...vault.pageTypes.extensions.map((e) => (typeof e === "string" ? e : e.name)),
  ]
    .map((t) => `- ${t}`)
    .join("\n");

  const agentsPath = join(vault.path, "AGENTS.md");
  // Single async stat-then-read, not existsSync+readFile, so the function
  // is uniformly async on the hot path.
  const vaultNotes = await readFile(agentsPath, "utf8").catch(() => "_No AGENTS.md present._");

  return [
    systemBaseBody,
    "",
    "## This vault",
    "",
    "### Enabled invariants",
    enabledInvariants || "_(none enabled)_",
    "",
    "### Page types",
    pageTypes,
    "",
    "### Vault notes (from AGENTS.md)",
    vaultNotes,
  ].join("\n");
}
