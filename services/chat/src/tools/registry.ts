import { z } from 'zod';
import { DEFAULT_TOOLS, LLMTool } from '.';

/**
 * A lightweight container for LLM-exposed tools.
 *
 *  – Guarantees unique names (throws on duplicates)
 *  – Lets you fetch, iterate, or subset tools
 *  – Converts the whole set to JSON-schema for
 *    function-calling / LangChain / etc.
 */
export class ToolRegistry {
  private readonly map = new Map<string, LLMTool<any, any, any>>();

  constructor(initial?: Iterable<LLMTool<any, any, any>>) {
    if (initial) this.registerMany(initial);
  }

  static fromDefault(): ToolRegistry {
    return new ToolRegistry(DEFAULT_TOOLS);
  }

  /** Add a single tool (enforces unique name). */
  register(tool: LLMTool<any, any, any>): this {
    if (this.map.has(tool.name)) {
      throw new Error(`Tool name "${tool.name}" is already registered`);
    }
    this.map.set(tool.name, tool);
    return this;
  }

  /** Add several at once. */
  registerMany(tools: Iterable<LLMTool<any, any, any>>): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** True if the registry contains a given tool name. */
  has(name: string): boolean {
    return this.map.has(name);
  }

  /** Get a tool by name (undefined if not present). */
  get<T extends LLMTool<any, any, any> = LLMTool<any, any, any>>(name: string): T | undefined {
    return this.map.get(name) as T | undefined;
  }

  /** All tools as an **array** (stable insertion order). */
  list(): readonly LLMTool<any, any, any>[] {
    return [...this.map.values()];
  }

  /** Pick a subset by name (useful when you want per-LLM -call filtering). */
  subset(names: Iterable<string>): ToolRegistry {
    const sub = new ToolRegistry();
    for (const n of names) {
      const t = this.get(n);
      if (t) sub.register(t);
    }
    return sub;
  }

  toolUnionSchema() {
    const variants = this.list().map(t =>
      z.object({
        toolName: z.literal(t.name),
        args: t.inputSchema, // args validated against that tool’s schema
      }),
    );

    if (variants.length === 0) {
      // should never happen, but keep TS happy
      return z.never();
    }
    if (variants.length === 1) {
      // single tool → no discriminated union needed
      return variants[0];
    }

    // cast the plain array to a tuple so TS is satisfied
    return z.discriminatedUnion(
      'toolName',
      variants as [(typeof variants)[0], (typeof variants)[1], ...typeof variants],
    );
  }
}
