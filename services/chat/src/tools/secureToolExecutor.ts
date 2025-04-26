import { getLogger } from '@dome/logging';
import { validateToolInput } from '../utils/inputValidator';
import { ForbiddenError, BadRequestError } from '@dome/errors';
import { getUserInfo, UserRole } from '@dome/common/src/middleware/enhancedAuthMiddleware';
import { Context } from 'hono';

/**
 * Tool execution result
 */
export interface ToolResult {
  toolName: string;
  input: unknown;
  output: unknown;
  error?: string;
  executionTime?: number;
}

/**
 * Tool definition interface
 */
export interface Tool {
  /**
   * Name of the tool
   */
  name: string;

  /**
   * Description of the tool
   */
  description: string;

  /**
   * Required permissions to use this tool
   */
  requiredPermissions: string[];

  /**
   * Minimum required role to use this tool
   */
  minimumRole: UserRole;

  /**
   * Risk level of the tool (1-5)
   * 1 = Low risk, 5 = High risk
   */
  riskLevel: number;

  /**
   * Whether the tool requires explicit user consent
   */
  requiresConsent: boolean;

  /**
   * Execute the tool
   * @param input Tool input
   * @param env Environment bindings
   * @returns Tool output
   */
  execute: (input: unknown, env: Env) => Promise<unknown>;
}

/**
 * Tool intent detection result
 */
interface ToolIntentDetection {
  /**
   * Whether the intent is valid
   */
  isValid: boolean;

  /**
   * Confidence score (0-1)
   */
  confidence: number;

  /**
   * Reason for the decision
   */
  reason: string;

  /**
   * Detected intent
   */
  intent: string;
}

/**
 * Secure tool executor with sandboxing and intent detection
 */
export class SecureToolExecutor {
  private logger = getLogger().child({ component: 'secureToolExecutor' });
  private tools: Map<string, Tool> = new Map();
  private context?: Context;

  /**
   * Create a new secure tool executor
   * @param context Hono context for user authentication
   */
  constructor(context?: Context) {
    this.context = context;
  }

  /**
   * Register a tool
   * @param tool Tool to register
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.logger.info({ toolName: tool.name }, 'Tool registered');
  }

  /**
   * Get a tool by name
   * @param name Tool name
   * @returns Tool or undefined if not found
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   * @returns Array of tools
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools available to the current user
   * @returns Array of available tools
   */
  getAvailableTools(): Tool[] {
    if (!this.context) {
      return [];
    }

    try {
      const userInfo = getUserInfo(this.context);

      return Array.from(this.tools.values()).filter(tool => {
        // Check if user has required role
        if (userInfo.role === UserRole.ADMIN) {
          return true; // Admins can use all tools
        }

        const roleHierarchy = {
          [UserRole.USER]: 1,
          [UserRole.ADMIN]: 2,
        };

        if (roleHierarchy[userInfo.role] < roleHierarchy[tool.minimumRole]) {
          return false;
        }

        // Check if user has required permissions
        if (tool.requiredPermissions.length > 0) {
          const hasAllPermissions = tool.requiredPermissions.every(
            permission =>
              userInfo.permissions?.includes(permission) || userInfo.permissions?.includes('*'),
          );

          if (!hasAllPermissions) {
            return false;
          }
        }

        return true;
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to get available tools');
      return [];
    }
  }

  /**
   * Detect tool intent from a query
   * @param query User query
   * @param toolName Suggested tool name
   * @returns Tool intent detection result
   */
  async detectToolIntent(query: string, toolName: string): Promise<ToolIntentDetection> {
    this.logger.debug({ query, toolName }, 'Detecting tool intent');

    // Get the tool
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        isValid: false,
        confidence: 0,
        reason: `Tool ${toolName} not found`,
        intent: '',
      };
    }

    // Simple pattern-based intent detection
    // In a real implementation, this would use an LLM or a classifier

    // Tool-specific patterns
    const toolPatterns: Record<string, RegExp[]> = {
      calculator: [/calculate|compute|evaluate|solve|math|equation|arithmetic|formula/i],
      calendar: [/calendar|schedule|appointment|meeting|event|reminder|date/i],
      weather: [/weather|temperature|forecast|rain|snow|sunny|cloudy|humidity|wind/i],
      web_search: [/search|find|look up|google|information about|tell me about|what is/i],
    };

    // Check if query matches any pattern for the tool
    const patterns = toolPatterns[toolName] || [];
    let matchCount = 0;

    for (const pattern of patterns) {
      if (pattern.test(query)) {
        matchCount++;
      }
    }

    // Calculate confidence based on match count
    const confidence = patterns.length > 0 ? matchCount / patterns.length : 0;

    // High-risk tools require higher confidence
    const confidenceThreshold = tool.riskLevel >= 4 ? 0.8 : 0.5;

    if (confidence >= confidenceThreshold) {
      return {
        isValid: true,
        confidence,
        reason: `Query matches ${matchCount} patterns for ${toolName}`,
        intent: toolName,
      };
    }

    return {
      isValid: false,
      confidence,
      reason: `Insufficient confidence (${confidence.toFixed(2)}) for ${toolName}`,
      intent: '',
    };
  }

  /**
   * Execute a tool with security checks
   * @param toolName Name of the tool to execute
   * @param input Tool input
   * @param query Original user query for intent detection
   * @param env Environment bindings
   * @returns Tool execution result
   */
  async executeTool(
    toolName: string,
    input: unknown,
    query: string,
    env: Env,
  ): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      this.logger.info({ toolName, input }, 'Executing tool');

      // Get the tool
      const tool = this.tools.get(toolName);

      if (!tool) {
        throw new BadRequestError(`Tool ${toolName} not found`);
      }

      // Check user permissions if context is available
      if (this.context) {
        try {
          const userInfo = getUserInfo(this.context);

          // Check if user has required role
          if (userInfo.role !== UserRole.ADMIN) {
            const roleHierarchy = {
              [UserRole.USER]: 1,
              [UserRole.ADMIN]: 2,
            };

            if (roleHierarchy[userInfo.role] < roleHierarchy[tool.minimumRole]) {
              throw new ForbiddenError(`Required role: ${tool.minimumRole}`);
            }
          }

          // Check if user has required permissions
          if (tool.requiredPermissions.length > 0) {
            const hasAllPermissions = tool.requiredPermissions.every(
              permission =>
                userInfo.permissions?.includes(permission) || userInfo.permissions?.includes('*'),
            );

            if (!hasAllPermissions) {
              throw new ForbiddenError(
                `Missing required permissions: ${tool.requiredPermissions.join(', ')}`,
              );
            }
          }
        } catch (error) {
          if (error instanceof ForbiddenError) {
            throw error;
          }

          throw new ForbiddenError('Authentication required to use this tool');
        }
      }

      // Detect tool intent
      const intentDetection = await this.detectToolIntent(query, toolName);

      // For high-risk tools, require valid intent
      if (tool.riskLevel >= 3 && !intentDetection.isValid) {
        this.logger.warn({ toolName, intentDetection }, 'Tool intent validation failed');

        throw new ForbiddenError(`Tool intent validation failed: ${intentDetection.reason}`);
      }

      // Validate and sanitize input
      const validatedInput = validateToolInput(toolName, input);

      // Execute the tool in a sandboxed environment
      const output = await this.executeInSandbox(tool, validatedInput, env);

      const endTime = performance.now();
      const executionTime = endTime - startTime;

      this.logger.info(
        {
          toolName,
          executionTime,
          outputPreview: typeof output === 'string' ? output.substring(0, 100) : 'complex output',
        },
        'Tool execution completed',
      );

      return {
        toolName,
        input: validatedInput,
        output,
        executionTime,
      };
    } catch (error) {
      const endTime = performance.now();
      const executionTime = endTime - startTime;

      this.logger.error(
        {
          err: error,
          toolName,
          executionTime,
        },
        'Tool execution failed',
      );

      return {
        toolName,
        input,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      };
    }
  }

  /**
   * Execute a tool in a sandboxed environment
   * @param tool Tool to execute
   * @param input Validated tool input
   * @param env Environment bindings
   * @returns Tool output
   */
  private async executeInSandbox(tool: Tool, input: unknown, env: Env): Promise<unknown> {
    // In a real implementation, this would use a proper sandboxing mechanism
    // For now, we'll just execute the tool directly with a timeout

    // Set a timeout based on the tool's risk level
    const timeoutMs = 5000 - tool.riskLevel * 1000;

    try {
      // Execute with timeout
      const result = await Promise.race([
        tool.execute(input, env),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Tool execution timed out')), timeoutMs),
        ),
      ]);

      return result;
    } catch (error) {
      this.logger.error(
        {
          err: error,
          toolName: tool.name,
        },
        'Error in sandboxed execution',
      );

      throw error;
    }
  }
}

/**
 * Create a calculator tool
 * @returns Calculator tool
 */
export function createCalculatorTool(): Tool {
  return {
    name: 'calculator',
    description: 'Performs mathematical calculations',
    requiredPermissions: ['tools:calculator'],
    minimumRole: UserRole.USER,
    riskLevel: 1,
    requiresConsent: false,

    async execute(input: unknown): Promise<unknown> {
      const { expression } = input as { expression: string };

      // Validate expression (additional security check)
      if (!/^[0-9+\-*/().\s]*$/.test(expression)) {
        throw new BadRequestError('Expression contains invalid characters');
      }

      // Evaluate the expression safely
      // Note: In a real implementation, use a proper math library
      try {
        // Use Function constructor with strict mode to evaluate the expression
        // This is still not 100% safe, but better than eval
        const result = new Function(`"use strict"; return (${expression});`)();
        return { result };
      } catch (error) {
        throw new BadRequestError(
          `Failed to evaluate expression: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}

/**
 * Create a weather tool
 * @returns Weather tool
 */
export function createWeatherTool(): Tool {
  return {
    name: 'weather',
    description: 'Gets weather information for a location',
    requiredPermissions: ['tools:weather'],
    minimumRole: UserRole.USER,
    riskLevel: 1,
    requiresConsent: false,

    async execute(input: unknown, env: Env): Promise<unknown> {
      const { location, date } = input as { location: string; date?: string };

      // In a real implementation, this would call a weather API
      // For now, return mock data
      return {
        location,
        date: date || new Date().toISOString().split('T')[0],
        temperature: {
          current: 22,
          min: 18,
          max: 25,
        },
        conditions: 'Partly cloudy',
        humidity: 65,
        windSpeed: 10,
      };
    },
  };
}

/**
 * Create a web search tool
 * @returns Web search tool
 */
export function createWebSearchTool(): Tool {
  return {
    name: 'web_search',
    description: 'Searches the web for information',
    requiredPermissions: ['tools:web_search'],
    minimumRole: UserRole.USER,
    riskLevel: 2,
    requiresConsent: true,

    async execute(input: unknown, env: Env): Promise<unknown> {
      const { query, limit = 5 } = input as { query: string; limit: number };

      // In a real implementation, this would call a search API
      // For now, return mock data
      return {
        query,
        results: [
          {
            title: 'Example Search Result 1',
            url: 'https://example.com/result1',
            snippet: 'This is a snippet of the search result content...',
          },
          {
            title: 'Example Search Result 2',
            url: 'https://example.com/result2',
            snippet: 'Another snippet of search result content...',
          },
        ].slice(0, limit),
      };
    },
  };
}

/**
 * Initialize the tool registry with default tools
 * @param context Hono context for user authentication
 * @returns Secure tool executor
 */
export function initializeToolRegistry(context?: Context): SecureToolExecutor {
  const executor = new SecureToolExecutor(context);

  // Register default tools
  executor.registerTool(createCalculatorTool());
  executor.registerTool(createWeatherTool());
  executor.registerTool(createWebSearchTool());

  return executor;
}
