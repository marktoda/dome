import { Document } from '../types';
import { getLogger } from '@dome/logging';
import {
  DEFAULT_MAX_TOTAL_DOC_TOKENS,
  DOC_METADATA_TOKENS,
  approximateTokenCount,
} from './tokenConstants';

/**
 * Format retrieved documents for inclusion in a prompt
 * @param docs The documents to format
 * @param includeSourceInfo Whether to include source information
 * @param maxTotalTokens Maximum total tokens for all documents
 * @returns Formatted document string
 */
export function formatDocsForPrompt(
  docs: Document[],
  includeSourceInfo = true,
  maxTotalTokens = DEFAULT_MAX_TOTAL_DOC_TOKENS,
): string {
  if (!docs || docs.length === 0) {
    return '';
  }

  // First, format all documents
  const formattedDocs = docs.map((doc, index) => {
    const docNumber = index + 1;
    let formattedDoc = `[${docNumber}] ${doc.title}\n${doc.body}`;

    if (includeSourceInfo && doc.metadata) {
      formattedDoc += `\nSource: ${doc.metadata.source}`;
      if (doc.metadata.createdAt) {
        formattedDoc += ` (${formatDate(doc.metadata.createdAt)})`;
      }
    }

    // Calculate approximate token count for this document
    const tokenCount = approximateTokenCount(formattedDoc);

    return {
      text: formattedDoc,
      tokenCount,
      relevanceScore: doc.metadata?.relevanceScore || 0,
    };
  });

  // Sort by relevance score (highest first)
  formattedDocs.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Limit total tokens
  let totalTokens = 0;
  const includedDocs: string[] = [];

  for (const doc of formattedDocs) {
    // If adding this document would exceed the limit, skip it
    if (totalTokens + doc.tokenCount > maxTotalTokens) {
      continue;
    }

    includedDocs.push(doc.text);
    totalTokens += doc.tokenCount;
  }

  return includedDocs.join('\n\n');
}

/**
 * Format a date string for display
 * @param dateString The date string to format
 * @returns Formatted date string
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch (error) {
    return dateString; // Fallback to original string if parsing fails
  }
}

/**
 * Truncate text to a maximum number of tokens
 * This is a placeholder implementation that should be replaced with
 * actual token counting in a real implementation
 * @param text The text to truncate
 * @param maxTokens The maximum number of tokens
 * @returns Truncated text
 */
export function truncateToMaxTokens(text: string, maxTokens: number): string {
  // Use the standardized token approximation
  const approximateTokens = approximateTokenCount(text);

  if (approximateTokens <= maxTokens) {
    return text;
  }

  // Truncate to approximate length and add ellipsis
  const truncatedLength = Math.floor(maxTokens * 4);
  return text.substring(0, truncatedLength) + '...';
}

/**
 * Truncate a document to a maximum number of tokens
 * @param doc The document to truncate
 * @param maxTokens The maximum number of tokens
 * @returns Truncated document
 */
export function truncateDocumentToMaxTokens(doc: Document, maxTokens: number): Document {
  // Reserve tokens for title and metadata
  const titleTokens = approximateTokenCount(doc.title);
  const metadataTokens = DOC_METADATA_TOKENS;
  const bodyMaxTokens = maxTokens - titleTokens - metadataTokens;

  // If body is already within limits, return the original document
  const bodyTokens = approximateTokenCount(doc.body);
  if (bodyTokens <= bodyMaxTokens) {
    return doc;
  }

  // Truncate the body
  const truncatedBody = truncateToMaxTokens(doc.body, bodyMaxTokens);

  return {
    ...doc,
    body: truncatedBody,
  };
}
