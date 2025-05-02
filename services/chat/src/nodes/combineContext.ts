import { getLogger, logError } from "@dome/logging";
import { ObservabilityService } from "../services/observabilityService";
import { ModelFactory } from "../services/modelFactory";
import { AgentState, Document, ToolResult } from "../types";
import { toDomeError } from "../utils/errors";
import { countTokens } from "../utils/tokenCounter";
import { formatDocsForPrompt } from "../utils/promptHelpers";

/**
 * Combine Context LLM Node
 *
 * Synthesizes retrieved and tool-derived content into a coherent prompt-ready context.
 * This node is responsible for taking reranked retrieval results and tool execution
 * results and combining them into a cohesive context for the LLM to generate an answer.
 *
 * The node:
 * 1. Collects all reranked documents and tool results
 * 2. Uses an LLM to synthesize this information into a coherent context
 * 3. Explicitly labels sources for attribution and user transparency
 * 4. Organizes information by relevance and type
 * 5. Updates agent state with the combined context
 *
 * This node bridges between the retrieval/tool execution phases and the answer
 * generation phase, preparing all information in an optimal format for the LLM.
 *
 * @param state Current agent state
 * @param env Environment bindings
 * @returns Updated agent state with synthesized context
 */
export async function combineContext(
  state: AgentState,
  env: Env,
): Promise<Partial<AgentState>> {
  const log = getLogger().child({ node: "combineContextLLM" });
  const started = performance.now();
  const traceId = state.metadata?.traceId ?? "";
  const spanId = ObservabilityService.startSpan(env, traceId, "combineContextLLM", state);

  try {
    /* ── 1 · gather all documents and tool results ──────────────── */
    // Get retrieval results
    const rerankedDocs: Document[] = [];

    // Collect all retrieved documents from the retrievals array
    if (state.retrievals && state.retrievals.length > 0) {
      for (const retrieval of state.retrievals) {
        const sourceType = retrieval.sourceType || retrieval.category;

        if (retrieval.chunks && retrieval.chunks.length > 0) {
          // Convert document chunks to standard document format
          const docs = retrieval.chunks.map(chunk => ({
            id: chunk.id,
            title: chunk.metadata.title || `${sourceType} result`,
            body: chunk.content,
            metadata: {
              source: chunk.metadata.source,
              sourceType: chunk.metadata.sourceType,
              createdAt: chunk.metadata.createdAt || new Date().toISOString(),
              relevanceScore: chunk.metadata.rerankerScore || chunk.metadata.relevanceScore || 0,
              mimeType: "text/plain"
            }
          }));

          rerankedDocs.push(...docs);
        }
      }
    }

    // Add any existing documents from the state (could be from previous nodes)
    if (state.docs && state.docs.length > 0) {
      const existingDocIds = new Set(rerankedDocs.map(d => d.id));

      for (const doc of state.docs) {
        // Only add docs that aren't already included
        if (!existingDocIds.has(doc.id)) {
          rerankedDocs.push(doc);
        }
      }
    }

    // Get all tool results from all task entities
    const allToolResults: ToolResult[] = Object.values(state.taskEntities || {}).flatMap(
      task => task.toolResults || []
    );

    /* ── 2 · prepare documents by relevance and limit token count ──────────────── */
    // Sort documents by relevance score (descending)
    rerankedDocs.sort((a, b) =>
      (b.metadata.relevanceScore || 0) - (a.metadata.relevanceScore || 0)
    );

    // Set a token limit for context
    const modelId = state.options?.modelId ?? "gpt-4";
    const contextTokenLimit = 4000; // Adjust based on model constraints

    // Calculate tokens for each document and keep track of total
    let currentTokenCount = 0;
    const selectedDocs: Document[] = [];

    for (const doc of rerankedDocs) {
      const docTokens = countTokens(doc.body);

      // If adding this document would exceed our limit, stop adding
      if (currentTokenCount + docTokens > contextTokenLimit) {
        break;
      }

      selectedDocs.push(doc);
      currentTokenCount += docTokens;
    }

    /* ── 3 · format documents and tool results for synthesis ──────────────── */
    const userQuery = state.messages[0].content;

    // Format documents for context
    const includeSources = state.options?.includeSourceInfo ?? true;
    const formattedDocs = formatDocsForPrompt(selectedDocs, includeSources, contextTokenLimit);

    // Format tool results
    const formattedTools = formatToolResults(allToolResults);

    /* ── 4 · use LLM to synthesize context ──────────────── */
    // Build the prompt for the context combiner LLM
    const contextCombinerPrompt = `
You are Context Synthesizer, an AI that organizes and synthesizes information from multiple sources.

USER QUERY: ${userQuery}

YOUR TASK:
Create a comprehensive, well-structured context document that synthesizes the following information sources.
Focus on connecting related information across sources, removing redundancy, and organizing for coherence.
Preserve specific technical details, code examples, numerical data, and facts.
Label sources explicitly by index to maintain clear attribution.
Format in clear sections, using bullet points and headings when appropriate.

INFORMATION SOURCES:
${formattedDocs || "No relevant documents found."}

${formattedTools ? `TOOL RESULTS:\n${formattedTools}` : ""}

SYNTHESIZED CONTEXT OUTPUT:
`;

    // Create the model for context synthesis
    const model = ModelFactory.createChatModel(env, {
      modelId,
      temperature: 0.2, // Low temperature for deterministic synthesis
      maxTokens: 2000,  // Limit response size
    });

    // Call the model to synthesize context
    const messages = [{ role: 'user', content: contextCombinerPrompt }];
    const response = await model.invoke(messages.map(m => ({
      role: m.role,
      content: m.content,
    })));

    const synthesizedContext = response.text;

    /* ── 5 · build state update ──────────────── */
    // Calculate execution time
    const elapsed = performance.now() - started;

    // Log success
    log.info({
      docsCount: selectedDocs.length,
      toolsCount: allToolResults.length,
      contextTokens: currentTokenCount,
      synthesizedTokens: countTokens(synthesizedContext),
      elapsedMs: elapsed
    }, "Context synthesis complete");

    // End span with successful result
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      "combineContextLLM",
      state,
      // Just pass state without custom additions that aren't in the AgentState type
      state,
      elapsed
    );

    // Return state updates
    return {
      docs: selectedDocs,
      // Store synthesized context for the next node to use
      reasoning: [synthesizedContext],
      metadata: {
        currentNode: "combineContext",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          combineContextLLM: elapsed
        }
      }
    };

  } catch (err) {
    // Handle errors
    const domeError = toDomeError(err);
    const elapsed = performance.now() - started;

    // Log the error
    logError(domeError, "Error in combineContextLLM", { traceId, spanId });

    // End span with error
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      "combineContextLLM",
      state,
      state,
      elapsed
    );

    // Format error for state
    const formattedError = {
      node: "combineContextLLM",
      message: domeError.message,
      timestamp: Date.now()
    };

    // Return error state update with fallback reasoning
    return {
      metadata: {
        currentNode: "combineContextLLM",
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          combineContextLLM: elapsed
        }
      },
      // Add fallback reasoning for downstream nodes
      reasoning: ["Unable to synthesize context due to an error. Proceeding with raw documents."]
    };
  }
}

/**
 * Format tool results for inclusion in the prompt
 */
function formatToolResults(results: ToolResult[]): string {
  if (!results || results.length === 0) {
    return "";
  }

  return results
    .map((r, i) => {
      const out = r.error
        ? `Error: ${r.error}`
        : typeof r.output === "string"
          ? r.output
          : JSON.stringify(r.output, null, 2);
      return `[Tool ${i + 1}] ${r.toolName}\nInput: ${JSON.stringify(r.input, null, 2)}\nOutput: ${out}`;
    })
    .join("\n\n");
}
