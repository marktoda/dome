import { getLogger } from '@dome/logging';

/**
 * Interface for tool parameters
 */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: any;
}

/**
 * Interface for tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute: (input: any, env: Env) => Promise<any>;
  validateInput?: (input: any) => { valid: boolean; error?: string };
  category: ToolCategory;
  requiresAuth: boolean;
  examples: string[];
}

/**
 * Tool categories
 */
export enum ToolCategory {
  SEARCH = 'search',
  CALCULATION = 'calculation',
  EXTERNAL_DATA = 'external_data',
  UTILITY = 'utility',
  SYSTEM = 'system',
}

/**
 * Registry for tools
 */
export class ToolRegistry {
  private static tools: Map<string, ToolDefinition> = new Map();
  private static logger = getLogger().child({ component: 'ToolRegistry' });

  /**
   * Register a tool with the registry
   * @param tool Tool definition
   */
  static registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn({ toolName: tool.name }, 'Tool already registered, overwriting');
    }
    
    this.tools.set(tool.name, tool);
    this.logger.info(
      { 
        toolName: tool.name, 
        category: tool.category,
        paramCount: tool.parameters.length,
      }, 
      'Tool registered'
    );
  }

  /**
   * Get a tool by name
   * @param name Tool name
   * @returns Tool definition or undefined if not found
   */
  static getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   * @returns Array of tool definitions
   */
  static getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools by category
   * @param category Tool category
   * @returns Array of tool definitions in the specified category
   */
  static getToolsByCategory(category: ToolCategory): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(tool => tool.category === category);
  }

  /**
   * Check if a tool exists
   * @param name Tool name
   * @returns True if the tool exists, false otherwise
   */
  static hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Unregister a tool
   * @param name Tool name
   * @returns True if the tool was unregistered, false if it didn't exist
   */
  static unregisterTool(name: string): boolean {
    const existed = this.tools.has(name);
    if (existed) {
      this.tools.delete(name);
      this.logger.info({ toolName: name }, 'Tool unregistered');
    }
    return existed;
  }

  /**
   * Get tool descriptions for LLM context
   * @returns Formatted string with tool descriptions
   */
  static getToolDescriptionsForLlm(): string {
    const descriptions = Array.from(this.tools.values()).map(tool => {
      const paramDescriptions = tool.parameters
        .map(param => `  - ${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}`)
        .join('\n');
      
      return `Tool: ${tool.name}\nDescription: ${tool.description}\nParameters:\n${paramDescriptions}\nExamples:\n${tool.examples.map(ex => `  - ${ex}`).join('\n')}`;
    });
    
    return descriptions.join('\n\n');
  }

  /**
   * Validate tool input against parameter definitions
   * @param toolName Tool name
   * @param input Tool input
   * @returns Validation result with error message if invalid
   */
  static validateToolInput(toolName: string, input: any): { valid: boolean; error?: string } {
    const tool = this.getTool(toolName);
    
    if (!tool) {
      return { valid: false, error: `Tool '${toolName}' not found` };
    }
    
    // Use custom validator if provided
    if (tool.validateInput) {
      return tool.validateInput(input);
    }
    
    // Default validation based on parameter definitions
    for (const param of tool.parameters) {
      if (param.required && (input[param.name] === undefined || input[param.name] === null)) {
        return { valid: false, error: `Required parameter '${param.name}' is missing` };
      }
      
      if (input[param.name] !== undefined && input[param.name] !== null) {
        // Type checking
        const actualType = Array.isArray(input[param.name]) ? 'array' : typeof input[param.name];
        if (actualType !== param.type) {
          return { 
            valid: false, 
            error: `Parameter '${param.name}' should be of type '${param.type}' but got '${actualType}'` 
          };
        }
      }
    }
    
    return { valid: true };
  }
}
