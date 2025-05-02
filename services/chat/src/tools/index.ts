import { z } from "zod";
import { DocumentChunk } from "../types";
import { webSearchTool } from "./webSearchTool";
import { docVectorSearchTool, codeVectorSearchTool, noteVectorSearchTool } from "./vectorSearch";
export { webSearchTool } from './webSearchTool';
export { ToolRegistry } from './registry';

export const DEFAULT_TOOLS = [webSearchTool];
export enum RetrievalToolType {
  WEB = "web",
  DOC = "doc",
  CODE = "code",
  NOTE = "note",
}
export const RETRIEVAL_TOOLS: Record<RetrievalToolType, RetrievalTool> = {
  [RetrievalToolType.WEB]: webSearchTool,
  [RetrievalToolType.DOC]: docVectorSearchTool,
  [RetrievalToolType.CODE]: codeVectorSearchTool,
  [RetrievalToolType.NOTE]: noteVectorSearchTool,
}


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

export type RetrievalInput = {
  query: string;
  userId: string;

}
export interface RetrievalTool<I = unknown, O = unknown, Raw = I> extends LLMTool<I, O, Raw> {
  retrieve(input: RetrievalInput, ctx: Env): Promise<O>
  toDocuments(input: O): DocumentChunk[];
};

