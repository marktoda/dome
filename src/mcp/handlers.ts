// MCP request-handler wiring. Extracted from `DomeMcpServer` so tests can
// drive registration against a stub Server (no stdio transport, no SDK
// import). The handler-shape mirrors @modelcontextprotocol/sdk's
// `Server.setRequestHandler(schema, handler)`.

import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolAdapter } from "./tool-adapters";
import type { PromptAdapter } from "./prompt-adapters";
import type { ResourceAdapter } from "./resource-adapters";

// Server-like surface: a tiny strict subset of @modelcontextprotocol/sdk's
// Server that the handler wiring depends on. Strict-typed so tests can pass a
// stub without `as any`. The schema parameter is treated opaquely (it's
// passed straight through to the SDK Server); we identify it only by object
// identity, never by structure.
export interface ServerLike {
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>): void;
}

export interface HandlerSurface {
  tools: ReadonlyArray<ToolAdapter>;
  prompts: ReadonlyArray<PromptAdapter>;
  resources: ResourceAdapter;
}

export function registerHandlers(server: ServerLike, surface: HandlerSurface): void {
  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: surface.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: "openApi3" }) as Record<string, unknown>,
    })),
  }));

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req: unknown) => {
    const { params } = req as { params: { name: string; arguments?: unknown } };
    const tool = surface.tools.find(t => t.name === params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${params.name}` }],
      };
    }
    const out = await tool.handler(params.arguments ?? {});
    if (out.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(out.value) }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(out.error) }],
    };
  });

  // prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: surface.prompts.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments ?? [],
    })),
  }));

  // prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (req: unknown) => {
    const { params } = req as { params: { name: string } };
    const p = surface.prompts.find(x => x.name === params.name);
    if (!p) throw new Error(`unknown prompt: ${params.name}`);
    return {
      description: p.description,
      messages: [{ role: "user", content: { type: "text", text: p.body } }],
    };
  });

  // resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await surface.resources.list(),
  }));

  // resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (req: unknown) => {
    const { params } = req as { params: { uri: string } };
    const content = await surface.resources.read(params.uri);
    if (!content) throw new Error(`unknown resource: ${params.uri}`);
    return {
      contents: [{ uri: content.uri, mimeType: content.mimeType, text: content.text }],
    };
  });
}
