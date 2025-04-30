import { z } from "zod";
import { webSearchTool } from "./webSearchTool";
export { webSearchTool } from './webSearchTool';
export { ToolRegistry } from './registry';

export const DEFAULT_TOOLS = [webSearchTool];


/**
 * LLM-facing tool.
 *  I  – parsed   input delivered to `execute`
 *  O  – parsed   output returned by `execute`
 *  Raw – *raw* JSON accepted by the schema (often P | undefined)
 */
export interface LLMTool<I = unknown, O = unknown, Raw = I> {
  name: string;
  description: string;

  /** Schema that *accepts* Raw and *produces* P */
  inputSchema: z.ZodType<I, any, Raw>;

  /** Schema that *accepts & produces* R (usually same for both) */
  outputSchema: z.ZodType<O>;

  execute(input: I, ctx: Env): Promise<O>;

  examples?: { input: I; output: O; description?: string }[];
  config?: Record<string, unknown>;
}
