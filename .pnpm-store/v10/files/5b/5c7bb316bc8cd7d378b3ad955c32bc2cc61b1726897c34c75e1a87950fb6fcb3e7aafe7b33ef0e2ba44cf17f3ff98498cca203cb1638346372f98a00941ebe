import type { Agent } from '@mastra/core/agent';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { ConvertedTool } from '@mastra/core/mcp';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import type * as http from 'node:http';
import type { IMastraLogger } from '@mastra/core/logger';
import type { InternalCoreTool } from '@mastra/core';
import type { ListPromptsResult } from '@modelcontextprotocol/sdk/types.js';
import { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { MastraBase } from '@mastra/core/base';
import { MCPServerBase } from '@mastra/core/mcp';
import type { MCPServerConfig } from '@mastra/core/mcp';
import type { MCPServerHonoSSEOptions } from '@mastra/core/mcp';
import type { MCPServerSSEOptions } from '@mastra/core/mcp';
import type { MCPToolType } from '@mastra/core/mcp';
import { objectInputType } from 'zod';
import { objectOutputType } from 'zod';
import { objectUtil } from 'zod';
import type { Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeContext } from '@mastra/core/di';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ServerDetailInfo } from '@mastra/core/mcp';
import type { ServerInfo } from '@mastra/core/mcp';
import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { SSEStreamingApi } from 'hono/streaming';
import { SSETransport } from 'hono-mcp-server-sse-transport';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Tool } from '@mastra/core/tools';
import { ToolExecutionContext } from '@mastra/core';
import type { ToolsInput } from '@mastra/core/agent';
import type { Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { ZodArray } from 'zod';
import { ZodObject } from 'zod';
import { ZodOptional } from 'zod';
import { ZodString } from 'zod';
import { ZodTypeAny } from 'zod';
import { ZodUnion } from 'zod';

export declare const allTools: ToolsInput;

declare type BaseServerOptions = {
    logger?: LogHandler;
    timeout?: number;
    capabilities?: ClientCapabilities;
    enableServerLogs?: boolean;
};

declare type ElicitationActions = {
    sendRequest: (request: ElicitRequest['params']) => Promise<ElicitResult>;
};
export { ElicitationActions }
export { ElicitationActions as ElicitationActions_alias_1 }
export { ElicitationActions as ElicitationActions_alias_2 }

export declare class ElicitationClientActions {
    private readonly client;
    private readonly logger;
    constructor({ client, logger }: ElicitationClientActionsConfig);
    /**
     * Set a handler for elicitation requests.
     * @param handler The callback function to handle the elicitation request.
     */
    onRequest(handler: (request: ElicitRequest['params']) => Promise<ElicitResult>): void;
}

declare interface ElicitationClientActionsConfig {
    client: InternalMastraMCPClient;
    logger: IMastraLogger;
}

declare type ElicitationHandler = (request: ElicitRequest['params']) => Promise<ElicitResult>;
export { ElicitationHandler }
export { ElicitationHandler as ElicitationHandler_alias_1 }
export { ElicitationHandler as ElicitationHandler_alias_2 }

declare type HttpServerDefinition = BaseServerOptions & {
    url: URL;
    command?: never;
    args?: never;
    env?: never;
    requestInit?: StreamableHTTPClientTransportOptions['requestInit'];
    eventSourceInit?: SSEClientTransportOptions['eventSourceInit'];
    reconnectionOptions?: StreamableHTTPClientTransportOptions['reconnectionOptions'];
    sessionId?: StreamableHTTPClientTransportOptions['sessionId'];
};

export declare class InternalMastraMCPClient extends MastraBase {
    name: string;
    private client;
    private readonly timeout;
    private logHandler?;
    private enableServerLogs?;
    private serverConfig;
    private transport?;
    private currentOperationContext;
    readonly resources: ResourceClientActions;
    readonly prompts: PromptClientActions;
    readonly elicitation: ElicitationClientActions;
    constructor({ name, version, server, capabilities, timeout, }: InternalMastraMCPClientOptions);
    /**
     * Log a message at the specified level
     * @param level Log level
     * @param message Log message
     * @param details Optional additional details
     */
    private log;
    private setupLogging;
    private connectStdio;
    private connectHttp;
    private isConnected;
    connect(): Promise<boolean>;
    /**
     * Get the current session ID if using the Streamable HTTP transport.
     * Returns undefined if not connected or not using Streamable HTTP.
     */
    get sessionId(): string | undefined;
    disconnect(): Promise<void>;
    listResources(): Promise<z.objectOutputType<{
        _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
    } & {
        nextCursor: z.ZodOptional<z.ZodString>;
    } & {
        resources: z.ZodArray<z.ZodObject<z.objectUtil.extendShape<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, {
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }>, "passthrough", z.ZodTypeAny, z.objectOutputType<z.objectUtil.extendShape<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, {
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }>, z.ZodTypeAny, "passthrough">, z.objectInputType<z.objectUtil.extendShape<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, {
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }>, z.ZodTypeAny, "passthrough">>, "many">;
    }, z.ZodTypeAny, "passthrough">>;
    readResource(uri: string): Promise<z.objectOutputType<{
        _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
    } & {
        contents: z.ZodArray<z.ZodUnion<[z.ZodObject<z.objectUtil.extendShape<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }, {
            text: z.ZodString;
        }>, "passthrough", z.ZodTypeAny, z.objectOutputType<z.objectUtil.extendShape<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }, {
            text: z.ZodString;
        }>, z.ZodTypeAny, "passthrough">, z.objectInputType<z.objectUtil.extendShape<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }, {
            text: z.ZodString;
        }>, z.ZodTypeAny, "passthrough">>, z.ZodObject<z.objectUtil.extendShape<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }, {
            blob: z.ZodString;
        }>, "passthrough", z.ZodTypeAny, z.objectOutputType<z.objectUtil.extendShape<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }, {
            blob: z.ZodString;
        }>, z.ZodTypeAny, "passthrough">, z.objectInputType<z.objectUtil.extendShape<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }, {
            blob: z.ZodString;
        }>, z.ZodTypeAny, "passthrough">>]>, "many">;
    }, z.ZodTypeAny, "passthrough">>;
    subscribeResource(uri: string): Promise<{}>;
    unsubscribeResource(uri: string): Promise<{}>;
    listResourceTemplates(): Promise<z.objectOutputType<{
        _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
    } & {
        nextCursor: z.ZodOptional<z.ZodString>;
    } & {
        resourceTemplates: z.ZodArray<z.ZodObject<z.objectUtil.extendShape<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, {
            uriTemplate: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }>, "passthrough", z.ZodTypeAny, z.objectOutputType<z.objectUtil.extendShape<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, {
            uriTemplate: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }>, z.ZodTypeAny, "passthrough">, z.objectInputType<z.objectUtil.extendShape<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
        }, {
            uriTemplate: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        }>, z.ZodTypeAny, "passthrough">>, "many">;
    }, z.ZodTypeAny, "passthrough">>;
    /**
     * Fetch the list of available prompts from the MCP server.
     */
    listPrompts(): Promise<ListPromptsResult>;
    /**
     * Get a prompt and its dynamic messages from the server.
     * @param name The prompt name
     * @param args Arguments for the prompt
     * @param version (optional) The prompt version to retrieve
     */
    getPrompt({ name, args, version, }: {
        name: string;
        args?: Record<string, any>;
        version?: string;
    }): Promise<GetPromptResult>;
    /**
     * Register a handler to be called when the prompt list changes on the server.
     * Use this to refresh cached prompt lists in the client/UI if needed.
     */
    setPromptListChangedNotificationHandler(handler: () => void): void;
    setResourceUpdatedNotificationHandler(handler: (params: z.infer<typeof ResourceUpdatedNotificationSchema>['params']) => void): void;
    setResourceListChangedNotificationHandler(handler: () => void): void;
    setElicitationRequestHandler(handler: ElicitationHandler): void;
    private convertInputSchema;
    private convertOutputSchema;
    tools(): Promise<Record<string, any>>;
}

export declare type InternalMastraMCPClientOptions = {
    name: string;
    server: MastraMCPServerDefinition;
    capabilities?: ClientCapabilities;
    version?: string;
    timeout?: number;
};

export { LoggingLevel }
export { LoggingLevel as LoggingLevel_alias_1 }
export { LoggingLevel as LoggingLevel_alias_2 }

declare type LogHandler = (logMessage: LogMessage) => void;
export { LogHandler }
export { LogHandler as LogHandler_alias_1 }
export { LogHandler as LogHandler_alias_2 }

declare interface LogMessage {
    level: LoggingLevel;
    message: string;
    timestamp: Date;
    serverName: string;
    details?: Record<string, any>;
    runtimeContext?: RuntimeContext | null;
}
export { LogMessage }
export { LogMessage as LogMessage_alias_1 }
export { LogMessage as LogMessage_alias_2 }

/**
 * @deprecated MastraMCPClient is deprecated and will be removed in a future release. Please use MCPClient instead.
 */
declare class MastraMCPClient extends InternalMastraMCPClient {
    constructor(args: InternalMastraMCPClientOptions);
}
export { MastraMCPClient }
export { MastraMCPClient as MastraMCPClient_alias_1 }
export { MastraMCPClient as MastraMCPClient_alias_2 }

declare type MastraMCPServerDefinition = StdioServerDefinition | HttpServerDefinition;
export { MastraMCPServerDefinition }
export { MastraMCPServerDefinition as MastraMCPServerDefinition_alias_1 }
export { MastraMCPServerDefinition as MastraMCPServerDefinition_alias_2 }

declare class MCPClient extends MastraBase {
    private serverConfigs;
    private id;
    private defaultTimeout;
    private mcpClientsById;
    private disconnectPromise;
    constructor(args: MCPClientOptions);
    get elicitation(): {
        onRequest: (serverName: string, handler: (request: ElicitRequest["params"]) => Promise<ElicitResult>) => Promise<void>;
    };
    get resources(): {
        list: () => Promise<Record<string, Resource[]>>;
        templates: () => Promise<Record<string, ResourceTemplate[]>>;
        read: (serverName: string, uri: string) => Promise<objectOutputType<    {
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        } & {
        contents: ZodArray<ZodUnion<[ZodObject<objectUtil.extendShape<    {
        uri: ZodString;
        mimeType: ZodOptional<ZodString>;
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        }, {
        text: ZodString;
        }>, "passthrough", ZodTypeAny, objectOutputType<objectUtil.extendShape<    {
        uri: ZodString;
        mimeType: ZodOptional<ZodString>;
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        }, {
        text: ZodString;
        }>, ZodTypeAny, "passthrough">, objectInputType<objectUtil.extendShape<    {
        uri: ZodString;
        mimeType: ZodOptional<ZodString>;
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        }, {
        text: ZodString;
        }>, ZodTypeAny, "passthrough">>, ZodObject<objectUtil.extendShape<    {
        uri: ZodString;
        mimeType: ZodOptional<ZodString>;
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        }, {
        blob: ZodString;
        }>, "passthrough", ZodTypeAny, objectOutputType<objectUtil.extendShape<    {
        uri: ZodString;
        mimeType: ZodOptional<ZodString>;
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        }, {
        blob: ZodString;
        }>, ZodTypeAny, "passthrough">, objectInputType<objectUtil.extendShape<    {
        uri: ZodString;
        mimeType: ZodOptional<ZodString>;
        _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
        }, {
        blob: ZodString;
        }>, ZodTypeAny, "passthrough">>]>, "many">;
        }, ZodTypeAny, "passthrough">>;
        subscribe: (serverName: string, uri: string) => Promise<{}>;
        unsubscribe: (serverName: string, uri: string) => Promise<{}>;
        onUpdated: (serverName: string, handler: (params: {
            uri: string;
        }) => void) => Promise<void>;
        onListChanged: (serverName: string, handler: () => void) => Promise<void>;
    };
    get prompts(): {
        list: () => Promise<Record<string, Prompt[]>>;
        get: ({ serverName, name, args, version }: {
            serverName: string;
            name: string;
            args?: Record<string, any>;
            version?: string;
        }) => Promise<{
            [x: string]: unknown;
            messages: {
                [x: string]: unknown;
                content: {
                    [x: string]: unknown;
                    type: "text";
                    text: string;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                } | {
                    [x: string]: unknown;
                    type: "image";
                    data: string;
                    mimeType: string;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                } | {
                    [x: string]: unknown;
                    type: "audio";
                    data: string;
                    mimeType: string;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                } | {
                    [x: string]: unknown;
                    type: "resource_link";
                    name: string;
                    uri: string;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                    title?: string | undefined;
                    description?: string | undefined;
                    mimeType?: string | undefined;
                } | {
                    [x: string]: unknown;
                    type: "resource";
                    resource: {
                        [x: string]: unknown;
                        text: string;
                        uri: string;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                        mimeType?: string | undefined;
                    } | {
                        [x: string]: unknown;
                        uri: string;
                        blob: string;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                        mimeType?: string | undefined;
                    };
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                };
                role: "user" | "assistant";
            }[];
            _meta?: {
                [x: string]: unknown;
            } | undefined;
            description?: string | undefined;
        }>;
        onListChanged: (serverName: string, handler: () => void) => Promise<void>;
    };
    private addToInstanceCache;
    private makeId;
    disconnect(): Promise<void>;
    getTools(): Promise<Record<string, any>>;
    getToolsets(): Promise<Record<string, Record<string, any>>>;
    /**
     * @deprecated all resource actions have been moved to the this.resources object. Use this.resources.list() instead.
     */
    getResources(): Promise<Record<string, {
        [x: string]: unknown;
        name: string;
        uri: string;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
        title?: string | undefined;
        description?: string | undefined;
        mimeType?: string | undefined;
    }[]>>;
    /**
     * Get the current session IDs for all connected MCP clients using the Streamable HTTP transport.
     * Returns an object mapping server names to their session IDs.
     */
    get sessionIds(): Record<string, string>;
    private getConnectedClient;
    private getConnectedClientForServer;
    private eachClientTools;
}
export { MCPClient }
export { MCPClient as MCPClient_alias_1 }
export { MCPClient as MCPClient_alias_2 }

declare interface MCPClientOptions {
    id?: string;
    servers: Record<string, MastraMCPServerDefinition>;
    timeout?: number;
}
export { MCPClientOptions }
export { MCPClientOptions as MCPClientOptions_alias_1 }
export { MCPClientOptions as MCPClientOptions_alias_2 }

/**
 * @deprecated MCPConfiguration is deprecated and will be removed in a future release. Use MCPClient instead.
 */
declare class MCPConfiguration extends MCPClient {
    constructor(args: MCPClientOptions);
}
export { MCPConfiguration }
export { MCPConfiguration as MCPConfiguration_alias_1 }
export { MCPConfiguration as MCPConfiguration_alias_2 }

/**
 * @deprecated MCPConfigurationOptions is deprecated and will be removed in a future release. Use MCPClientOptions instead.
 */
declare interface MCPConfigurationOptions {
    id?: string;
    servers: Record<string, MastraMCPServerDefinition>;
    timeout?: number;
}
export { MCPConfigurationOptions }
export { MCPConfigurationOptions as MCPConfigurationOptions_alias_1 }
export { MCPConfigurationOptions as MCPConfigurationOptions_alias_2 }

declare type MCPRequestHandlerExtra = RequestHandlerExtra<any, any>;
export { MCPRequestHandlerExtra }
export { MCPRequestHandlerExtra as MCPRequestHandlerExtra_alias_1 }
export { MCPRequestHandlerExtra as MCPRequestHandlerExtra_alias_2 }

declare class MCPServer extends MCPServerBase {
    private server;
    private stdioTransport?;
    private sseTransport?;
    private sseHonoTransports;
    private streamableHTTPTransports;
    private httpServerInstances;
    private definedResources?;
    private definedResourceTemplates?;
    private resourceOptions?;
    private definedPrompts?;
    private promptOptions?;
    private subscriptions;
    readonly resources: ServerResourceActions;
    readonly prompts: ServerPromptActions;
    readonly elicitation: ElicitationActions;
    /**
     * Get the current stdio transport.
     */
    getStdioTransport(): StdioServerTransport | undefined;
    /**
     * Get the current SSE transport.
     */
    getSseTransport(): SSEServerTransport | undefined;
    /**
     * Get the current SSE Hono transport.
     */
    getSseHonoTransport(sessionId: string): SSETransport | undefined;
    /**
     * Get the current server instance.
     */
    getServer(): Server;
    /**
     * Construct a new MCPServer instance.
     * @param opts - Configuration options for the server, including registry metadata.
     */
    constructor(opts: MCPServerConfig & {
        resources?: MCPServerResources;
        prompts?: MCPServerPrompts;
    });
    /**
     * Handle an elicitation request by sending it to the connected client.
     * This method sends an elicitation/create request to the client and waits for the response.
     *
     * @param request - The elicitation request containing message and schema
     * @param serverInstance - Optional server instance to use; defaults to main server for backward compatibility
     * @returns Promise that resolves to the client's response
     */
    private handleElicitationRequest;
    /**
     * Creates a new Server instance configured with all handlers for HTTP sessions.
     * Each HTTP client connection gets its own Server instance to avoid routing conflicts.
     */
    private createServerInstance;
    /**
     * Registers all MCP handlers on a given server instance.
     * This allows us to create multiple server instances with identical functionality.
     */
    private registerHandlersOnServer;
    /**
     * Registers resource-related handlers on a server instance.
     */
    private registerResourceHandlersOnServer;
    /**
     * Registers prompt-related handlers on a server instance.
     */
    private registerPromptHandlersOnServer;
    private convertAgentsToTools;
    private convertWorkflowsToTools;
    /**
     * Convert and validate all provided tools, logging registration status.
     * Also converts agents and workflows into tools.
     * @param tools Tool definitions
     * @param agentsConfig Agent definitions to be converted to tools, expected from MCPServerConfig
     * @param workflowsConfig Workflow definitions to be converted to tools, expected from MCPServerConfig
     * @returns Converted tools registry
     */
    convertTools(tools: ToolsInput, agentsConfig?: Record<string, Agent>, workflowsConfig?: Record<string, Workflow>): Record<string, ConvertedTool>;
    /**
     * Start the MCP server using stdio transport (for Windsurf integration).
     */
    startStdio(): Promise<void>;
    /**
     * Handles MCP-over-SSE protocol for user-provided HTTP servers.
     * Call this from your HTTP server for both the SSE and message endpoints.
     *
     * @param url Parsed URL of the incoming request
     * @param ssePath Path for establishing the SSE connection (e.g. '/sse')
     * @param messagePath Path for POSTing client messages (e.g. '/message')
     * @param req Incoming HTTP request
     * @param res HTTP response (must support .write/.end)
     */
    startSSE({ url, ssePath, messagePath, req, res }: MCPServerSSEOptions): Promise<void>;
    /**
     * Handles MCP-over-SSE protocol for user-provided HTTP servers.
     * Call this from your HTTP server for both the SSE and message endpoints.
     *
     * @param url Parsed URL of the incoming request
     * @param ssePath Path for establishing the SSE connection (e.g. '/sse')
     * @param messagePath Path for POSTing client messages (e.g. '/message')
     * @param context Incoming Hono context
     */
    startHonoSSE({ url, ssePath, messagePath, context }: MCPServerHonoSSEOptions): Promise<Response>;
    /**
     * Handles MCP-over-StreamableHTTP protocol for user-provided HTTP servers.
     * Call this from your HTTP server for the streamable HTTP endpoint.
     *
     * @param url Parsed URL of the incoming request
     * @param httpPath Path for establishing the streamable HTTP connection (e.g. '/mcp')
     * @param req Incoming HTTP request
     * @param res HTTP response (must support .write/.end)
     * @param options Optional options to pass to the transport (e.g. sessionIdGenerator)
     */
    startHTTP({ url, httpPath, req, res, options, }: {
        url: URL;
        httpPath: string;
        req: http.IncomingMessage;
        res: http.ServerResponse<http.IncomingMessage>;
        options?: StreamableHTTPServerTransportOptions;
    }): Promise<void>;
    connectSSE({ messagePath, res, }: {
        messagePath: string;
        res: http.ServerResponse<http.IncomingMessage>;
    }): Promise<void>;
    connectHonoSSE({ messagePath, stream }: {
        messagePath: string;
        stream: SSEStreamingApi;
    }): Promise<void>;
    /**
     * Close the MCP server and all its connections
     */
    close(): Promise<void>;
    /**
     * Gets the basic information about the server, conforming to the Server schema.
     * @returns ServerInfo object.
     */
    getServerInfo(): ServerInfo;
    /**
     * Gets detailed information about the server, conforming to the ServerDetail schema.
     * @returns ServerDetailInfo object.
     */
    getServerDetail(): ServerDetailInfo;
    /**
     * Gets a list of tools provided by this MCP server, including their schemas.
     * This leverages the same tool information used by the internal ListTools MCP request.
     * @returns An object containing an array of tool information.
     */
    getToolListInfo(): {
        tools: Array<{
            name: string;
            description?: string;
            inputSchema: any;
            outputSchema?: any;
            toolType?: MCPToolType;
        }>;
    };
    /**
     * Gets information for a specific tool provided by this MCP server.
     * @param toolId The ID/name of the tool to retrieve.
     * @returns Tool information (name, description, inputSchema) or undefined if not found.
     */
    getToolInfo(toolId: string): {
        name: string;
        description?: string;
        inputSchema: any;
        outputSchema?: any;
        toolType?: MCPToolType;
    } | undefined;
    /**
     * Executes a specific tool provided by this MCP server.
     * @param toolId The ID/name of the tool to execute.
     * @param args The arguments to pass to the tool's execute function.
     * @param executionContext Optional context for the tool execution.
     * @returns A promise that resolves to the result of the tool execution.
     * @throws Error if the tool is not found, validation fails, or execution fails.
     */
    executeTool(toolId: string, args: any, executionContext?: {
        messages?: any[];
        toolCallId?: string;
    }): Promise<any>;
}
export { MCPServer }
export { MCPServer as MCPServer_alias_1 }
export { MCPServer as MCPServer_alias_2 }

export declare const mcpServerName = "firecrawl-mcp-fixture";

declare type MCPServerPromptMessagesCallback = ({ name, version, args, }: {
    name: string;
    version?: string;
    args?: any;
}) => Promise<PromptMessage[]>;
export { MCPServerPromptMessagesCallback }
export { MCPServerPromptMessagesCallback as MCPServerPromptMessagesCallback_alias_1 }
export { MCPServerPromptMessagesCallback as MCPServerPromptMessagesCallback_alias_2 }

declare type MCPServerPrompts = {
    listPrompts: () => Promise<Prompt[]>;
    getPromptMessages?: MCPServerPromptMessagesCallback;
};
export { MCPServerPrompts }
export { MCPServerPrompts as MCPServerPrompts_alias_1 }
export { MCPServerPrompts as MCPServerPrompts_alias_2 }

declare type MCPServerResourceContent = {
    text?: string;
} | {
    blob?: string;
};
export { MCPServerResourceContent }
export { MCPServerResourceContent as MCPServerResourceContent_alias_1 }
export { MCPServerResourceContent as MCPServerResourceContent_alias_2 }

declare type MCPServerResourceContentCallback = ({ uri, }: {
    uri: string;
}) => Promise<MCPServerResourceContent | MCPServerResourceContent[]>;
export { MCPServerResourceContentCallback }
export { MCPServerResourceContentCallback as MCPServerResourceContentCallback_alias_1 }
export { MCPServerResourceContentCallback as MCPServerResourceContentCallback_alias_2 }

declare type MCPServerResources = {
    listResources: () => Promise<Resource[]>;
    getResourceContent: MCPServerResourceContentCallback;
    resourceTemplates?: () => Promise<ResourceTemplate[]>;
};
export { MCPServerResources }
export { MCPServerResources as MCPServerResources_alias_1 }
export { MCPServerResources as MCPServerResources_alias_2 }

declare type MCPTool = {
    id?: InternalCoreTool['id'];
    description?: InternalCoreTool['description'];
    parameters: InternalCoreTool['parameters'];
    outputSchema?: InternalCoreTool['outputSchema'];
    execute: (params: any, options: Parameters<NonNullable<InternalCoreTool['execute']>>[1] & {
        elicitation: ElicitationActions;
        extra: MCPRequestHandlerExtra;
    }) => Promise<any>;
};
export { MCPTool }
export { MCPTool as MCPTool_alias_1 }
export { MCPTool as MCPTool_alias_2 }

/**
 * Client-side prompt actions for listing, getting, and subscribing to prompt changes.
 */
export declare class PromptClientActions {
    private readonly client;
    private readonly logger;
    constructor({ client, logger }: PromptClientActionsConfig);
    /**
     * Get all prompts from the connected MCP server.
     * @returns A list of prompts with their versions.
     */
    list(): Promise<Prompt[]>;
    /**
     * Get a specific prompt.
     * @param name The name of the prompt to get.
     * @param args Optional arguments for the prompt.
     * @param version Optional version of the prompt to get.
     * @returns The prompt content.
     */
    get({ name, args, version }: {
        name: string;
        args?: Record<string, any>;
        version?: string;
    }): Promise<GetPromptResult>;
    /**
     * Set a notification handler for when the list of available prompts changes.
     * @param handler The callback function to handle the notification.
     */
    onListChanged(handler: () => void): Promise<void>;
}

declare interface PromptClientActionsConfig {
    client: InternalMastraMCPClient;
    logger: IMastraLogger;
}

export { Resource }
export { Resource as Resource_alias_1 }
export { Resource as Resource_alias_2 }

export declare class ResourceClientActions {
    private readonly client;
    private readonly logger;
    constructor({ client, logger }: ResourceClientActionsConfig);
    /**
     * Get all resources from the connected MCP server.
     * @returns A list of resources.
     */
    list(): Promise<Resource[]>;
    /**
     * Get all resource templates from the connected MCP server.
     * @returns A list of resource templates.
     */
    templates(): Promise<ResourceTemplate[]>;
    /**
     * Read a specific resource.
     * @param uri The URI of the resource to read.
     * @returns The resource content.
     */
    read(uri: string): Promise<objectOutputType<    {
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    } & {
    contents: ZodArray<ZodUnion<[ZodObject<objectUtil.extendShape<    {
    uri: ZodString;
    mimeType: ZodOptional<ZodString>;
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    }, {
    text: ZodString;
    }>, "passthrough", ZodTypeAny, objectOutputType<objectUtil.extendShape<    {
    uri: ZodString;
    mimeType: ZodOptional<ZodString>;
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    }, {
    text: ZodString;
    }>, ZodTypeAny, "passthrough">, objectInputType<objectUtil.extendShape<    {
    uri: ZodString;
    mimeType: ZodOptional<ZodString>;
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    }, {
    text: ZodString;
    }>, ZodTypeAny, "passthrough">>, ZodObject<objectUtil.extendShape<    {
    uri: ZodString;
    mimeType: ZodOptional<ZodString>;
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    }, {
    blob: ZodString;
    }>, "passthrough", ZodTypeAny, objectOutputType<objectUtil.extendShape<    {
    uri: ZodString;
    mimeType: ZodOptional<ZodString>;
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    }, {
    blob: ZodString;
    }>, ZodTypeAny, "passthrough">, objectInputType<objectUtil.extendShape<    {
    uri: ZodString;
    mimeType: ZodOptional<ZodString>;
    _meta: ZodOptional<ZodObject<    {}, "passthrough", ZodTypeAny, objectOutputType<    {}, ZodTypeAny, "passthrough">, objectInputType<    {}, ZodTypeAny, "passthrough">>>;
    }, {
    blob: ZodString;
    }>, ZodTypeAny, "passthrough">>]>, "many">;
    }, ZodTypeAny, "passthrough">>;
    /**
     * Subscribe to a specific resource.
     * @param uri The URI of the resource to subscribe to.
     */
    subscribe(uri: string): Promise<{}>;
    /**
     * Unsubscribe from a specific resource.
     * @param uri The URI of the resource to unsubscribe from.
     */
    unsubscribe(uri: string): Promise<{}>;
    /**
     * Set a notification handler for when a specific resource is updated.
     * @param handler The callback function to handle the notification.
     */
    onUpdated(handler: (params: {
        uri: string;
    }) => void): Promise<void>;
    /**
     * Set a notification handler for when the list of available resources changes.
     * @param handler The callback function to handle the notification.
     */
    onListChanged(handler: () => void): Promise<void>;
}

declare interface ResourceClientActionsConfig {
    client: InternalMastraMCPClient;
    logger: IMastraLogger;
}

export { ResourceTemplate }
export { ResourceTemplate as ResourceTemplate_alias_1 }
export { ResourceTemplate as ResourceTemplate_alias_2 }

export declare const server: Server<{
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
        } | undefined;
    } | undefined;
}, {
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | undefined;
}, {
    [x: string]: unknown;
    _meta?: {
        [x: string]: unknown;
    } | undefined;
}>;

export declare const server_alias_1: MCPServer;

export declare class ServerPromptActions {
    private readonly getLogger;
    private readonly getSdkServer;
    private readonly clearDefinedPrompts;
    constructor(dependencies: ServerPromptActionsDependencies);
    /**
     * Notifies the server that the overall list of available prompts has changed.
     * This will clear the internal cache of defined prompts and send a list_changed notification to clients.
     */
    notifyListChanged(): Promise<void>;
}

declare interface ServerPromptActionsDependencies {
    getLogger: () => IMastraLogger;
    getSdkServer: () => Server;
    clearDefinedPrompts: () => void;
}

export declare class ServerResourceActions {
    private readonly getSubscriptions;
    private readonly getLogger;
    private readonly getSdkServer;
    private readonly clearDefinedResources;
    private readonly clearDefinedResourceTemplates;
    constructor(dependencies: ServerResourceActionsDependencies);
    /**
     * Checks if any resources have been updated.
     * If the resource is subscribed to by clients, an update notification will be sent.
     */
    notifyUpdated({ uri }: {
        uri: string;
    }): Promise<void>;
    /**
     * Notifies the server that the overall list of available resources has changed.
     * This will clear the internal cache of defined resources and send a list_changed notification to clients.
     */
    notifyListChanged(): Promise<void>;
}

declare interface ServerResourceActionsDependencies {
    getSubscriptions: () => Set<string>;
    getLogger: () => IMastraLogger;
    getSdkServer: () => Server;
    clearDefinedResources: () => void;
    clearDefinedResourceTemplates: () => void;
}

declare type StdioServerDefinition = BaseServerOptions & {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    url?: never;
    requestInit?: never;
    eventSourceInit?: never;
    reconnectionOptions?: never;
    sessionId?: never;
};

export declare const weatherTool: Tool<z.ZodObject<{
location: z.ZodString;
}, "strip", z.ZodTypeAny, {
location: string;
}, {
location: string;
}>, undefined, ToolExecutionContext<z.ZodObject<{
location: z.ZodString;
}, "strip", z.ZodTypeAny, {
location: string;
}, {
location: string;
}>>>;

export { }
