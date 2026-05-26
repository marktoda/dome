import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "../vault";

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

export class ResourceAdapter {
  constructor(private vault: Vault) {}

  async list(): Promise<ResourceListing[]> {
    return [
      { uri: ResourceUri.Index, name: "Index", description: "The vault catalog (index.md)" },
      { uri: ResourceUri.Log, name: "Log", description: "Append-only operation log (log.md)" },
      { uri: ResourceUri.VaultInfo, name: "Vault info", description: "Vault config + invariants + tiers" },
    ];
  }

  async read(uri: string): Promise<ResourceContent | null> {
    if (uri === ResourceUri.Index) {
      const text = await readFile(join(this.vault.path, "index.md"), "utf8");
      return { uri, mimeType: "text/markdown", text };
    }
    if (uri === ResourceUri.Log) {
      const text = await readFile(join(this.vault.path, "log.md"), "utf8");
      return { uri, mimeType: "text/markdown", text };
    }
    if (uri === ResourceUri.VaultInfo) {
      const text = JSON.stringify({
        path: this.vault.path,
        invariants: this.vault.config.invariants,
        pageTypes: this.vault.pageTypes,
      }, null, 2);
      return { uri, mimeType: "application/json", text };
    }
    // dome://page/<path>
    if (uri.startsWith(PAGE_URI_PREFIX)) {
      const path = uri.slice(PAGE_URI_PREFIX.length);
      const out = await this.vault.tools.readDocument({ path });
      if (out.result.ok) {
        return { uri, mimeType: "text/markdown", text: out.result.value.body };
      }
    }
    return null;
  }
}
