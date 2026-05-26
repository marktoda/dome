import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "../vault";
import type { AbstractSurface } from "../abstract-surface";

export const ResourceUri = {
  Index: "dome://index",
  Log: "dome://log",
  VaultInfo: "dome://vault/info",
} as const;
export type ResourceUri = typeof ResourceUri[keyof typeof ResourceUri];

const PAGE_URI_PREFIX = "dome://page/";

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface ResourceListing {
  uri: string;
  name: string;
  description: string;
}

/**
 * MCP-shaped resource adapter. Reads from AbstractSurface — applies the
 * `dome://` URI prefix when listing static descriptors; falls back to
 * surface.readDynamicResource for path-keyed URIs (`dome://page/<path>`).
 *
 * The legacy Vault-direct constructor is preserved for the v0.5.1+
 * migration window; new callers pass AbstractSurface.
 */
export class ResourceAdapter {
  private readonly surface: AbstractSurface | null;
  private readonly vault: Vault | null;

  constructor(input: AbstractSurface | Vault) {
    if (this.isAbstractSurface(input)) {
      this.surface = input;
      this.vault = null;
    } else {
      this.surface = null;
      this.vault = input;
    }
  }

  private isAbstractSurface(input: AbstractSurface | Vault): input is AbstractSurface {
    return Array.isArray((input as AbstractSurface).resources);
  }

  async list(): Promise<ResourceListing[]> {
    if (this.surface) {
      return this.surface.resources.map((r) => ({
        uri: `dome://${r.uri}`,
        name: r.name,
        description: r.description,
      }));
    }
    return [
      { uri: ResourceUri.Index, name: "Index", description: "The vault catalog (index.md)" },
      { uri: ResourceUri.Log, name: "Log", description: "Append-only operation log (log.md)" },
      { uri: ResourceUri.VaultInfo, name: "Vault info", description: "Vault config + invariants + tiers" },
    ];
  }

  async read(uri: string): Promise<ResourceContent | null> {
    if (this.surface) {
      if (uri.startsWith("dome://")) {
        const bareUri = uri.slice("dome://".length);
        // Static descriptors first:
        const desc = this.surface.resources.find((r) => r.uri === bareUri);
        if (desc) {
          const text = await desc.read();
          return { uri, mimeType: desc.mimeType, text };
        }
        // Dynamic lookup (page/<path>):
        const text = await this.surface.readDynamicResource(bareUri);
        if (text !== null) {
          return { uri, mimeType: "text/markdown", text };
        }
      }
      return null;
    }
    // Legacy Vault-direct path.
    const vault = this.vault!;
    if (uri === ResourceUri.Index) {
      const text = await readFile(join(vault.path, "index.md"), "utf8");
      return { uri, mimeType: "text/markdown", text };
    }
    if (uri === ResourceUri.Log) {
      const text = await readFile(join(vault.path, "log.md"), "utf8");
      return { uri, mimeType: "text/markdown", text };
    }
    if (uri === ResourceUri.VaultInfo) {
      const text = JSON.stringify({
        path: vault.path,
        invariants: vault.config.invariants,
        pageTypes: vault.pageTypes,
      }, null, 2);
      return { uri, mimeType: "application/json", text };
    }
    if (uri.startsWith(PAGE_URI_PREFIX)) {
      const path = uri.slice(PAGE_URI_PREFIX.length);
      const out = await vault.tools.readDocument({ path });
      if (out.result.ok) {
        return { uri, mimeType: "text/markdown", text: out.result.value.body };
      }
    }
    return null;
  }
}
