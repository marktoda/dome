import type { AbstractSurface } from "../abstract-surface";

export const ResourceUri = {
  Index: "dome://index",
  Log: "dome://log",
  VaultInfo: "dome://vault/info",
} as const;
export type ResourceUri = typeof ResourceUri[keyof typeof ResourceUri];

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
 * The only construction site is renderMcp(surface) in src/mcp/render-mcp.ts.
 * Future protocol renderers (renderHttp, renderVoice) consume the same
 * AbstractSurface shape and ship their own adapter.
 */
export class ResourceAdapter {
  constructor(private readonly surface: AbstractSurface) {}

  async list(): Promise<ResourceListing[]> {
    return this.surface.resources.map((r) => ({
      uri: `dome://${r.uri}`,
      name: r.name,
      description: r.description,
    }));
  }

  async read(uri: string): Promise<ResourceContent | null> {
    if (!uri.startsWith("dome://")) return null;
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
    return null;
  }
}
