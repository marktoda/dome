import { AgentState, Document } from '../types';
import { getLogger, getModelConfig, countTokens } from '@dome/common';
import { DOC_METADATA_TOKENS } from './tokenConstants';

/**
 * Filter documents by relevance score
 * @param docs The documents to filter
 * @param threshold The minimum relevance/similarity score threshold
 * @returns Filtered documents above the threshold
 */
export function scoreFilter(docs: Document[], threshold: number): Document[] {
  if (!docs || docs.length === 0 || threshold <= 0) {
    return docs || [];
  }

  return docs.filter(doc => {
    // Use relevanceScore from metadata, falling back to other similarity scores
    const score =
      doc.metadata.relevanceScore ||
      doc.metadata.semantic_similarity ||
      doc.metadata.confidence ||
      0;

    return score >= threshold;
  });
}

/**
 * Format a file list with a maximum length limit
 * @param files The list of files to format
 * @param maxLength The maximum length of the output string
 * @returns Formatted list of files
 */
export function concatListFiles(files: string[], maxLength: number): string {
  if (!files || files.length === 0) {
    return '';
  }

  // Start with a header
  let result = 'Files:\n';

  // Add each file to the list with a bullet point
  for (const file of files) {
    const nextLine = `- ${file}\n`;

    // Check if adding this file would exceed the max length
    if (result.length + nextLine.length > maxLength - 25) {
      // Reserve space for truncation message
      // If we would exceed the length, add a truncation message and stop
      const remainingCount = files.length - result.split('\n').length + 1;
      if (remainingCount > 0) {
        const truncationMessage = `... and ${remainingCount} more files`;
        // Make sure final string with truncation message doesn't exceed maxLength
        const availableSpace = maxLength - result.length;
        if (availableSpace >= truncationMessage.length) {
          result += truncationMessage;
        } else {
          // If not enough space, just add a simpler message
          result += '...';
        }
      }
      break;
    }

    result += nextLine;
  }

  return result.trim();
}

/**
 * Reduce context to fit within token limits
 * @param state The agent state containing documents
 * @param maxTokens The maximum number of tokens allowed
 * @returns Reduced document set and token count
 */
export function reduceRagContext(
  state: AgentState,
  maxTokens: number,
): { docs: Document[]; tokenCount: number } {
  if (!state.docs || state.docs.length === 0) {
    return { docs: [], tokenCount: 0 };
  }

  // Get the model ID from state options or use default
  const modelId = state.options.modelId || 'gpt-4';

  // Sort documents by relevance score (highest first)
  const sortedDocs = [...state.docs].sort((a, b) => {
    const scoreA =
      a.metadata.relevanceScore || a.metadata.semantic_similarity || a.metadata.confidence || 0;

    const scoreB =
      b.metadata.relevanceScore || b.metadata.semantic_similarity || b.metadata.confidence || 0;

    return scoreB - scoreA;
  });

  const results: Document[] = [];
  let totalTokens = 0;

  // Add documents until we hit the token limit
  for (const doc of sortedDocs) {
    // Calculate or use cached token count for this document
    let docTokens = doc.metadata.tokenCount;

    if (!docTokens) {
      // Compute token count if not available
      const title = doc.title || '';
      docTokens = countTokens(title + '\n' + doc.content, modelId) + DOC_METADATA_TOKENS;

      // Cache the token count in the metadata
      doc.metadata.tokenCount = docTokens;
    }

    // Check if adding this document would exceed the token limit
    if (totalTokens + docTokens > maxTokens && results.length > 0) {
      // Skip this document if we would exceed the limit and we already have at least one document
      break;
    }

    // Add the document and update the token count
    results.push(doc);
    totalTokens += docTokens;

    // If we've hit our limit exactly, stop
    if (totalTokens >= maxTokens) {
      break;
    }
  }

  return { docs: results, tokenCount: totalTokens };
}
