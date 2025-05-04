/**
 * Notion Provider Utilities
 *
 * This module contains utility functions for transforming Notion-specific
 * data structures into the standard format expected by tsunami.
 */
import { getLogger, getRequestId } from '@dome/common';
import { ValidationError } from '@dome/common/src/errors';
import { assertValid } from '../../utils/errors';
import { DomeMetadata } from '../../types/metadata';
import { ContentCategory, MimeType } from '@dome/common';
import { NotionBlock, NotionPage } from './client';

const logger = getLogger();
const METADATA_VERSION = '1.0';

/**
 * Creates metadata for Notion content
 *
 * @param workspaceId - The Notion workspace ID
 * @param pageId - The Notion page ID
 * @param updatedAt - The timestamp when the content was last updated
 * @param title - The title of the page or database
 * @param sizeBytes - The size of the content in bytes
 * @returns A complete metadata object
 */
export function createNotionMetadata(
  workspaceId: string,
  pageId: string,
  updatedAt: string,
  title: string,
  sizeBytes: number,
): DomeMetadata {
  const requestId = getRequestId();

  // Validate inputs
  assertValid(workspaceId && workspaceId.trim().length > 0, 'Workspace ID cannot be empty', {
    operation: 'createNotionMetadata',
    requestId,
  });

  assertValid(pageId && pageId.trim().length > 0, 'Page ID cannot be empty', {
    operation: 'createNotionMetadata',
    workspaceId,
    requestId,
  });

  assertValid(updatedAt && updatedAt.trim().length > 0, 'UpdatedAt cannot be empty', {
    operation: 'createNotionMetadata',
    workspaceId,
    pageId,
    requestId,
  });

  assertValid(sizeBytes >= 0, 'Size must be a non-negative number', {
    operation: 'createNotionMetadata',
    workspaceId,
    pageId,
    sizeBytes,
    requestId,
  });

  const metadata: DomeMetadata = {
    source: {
      type: 'notion',
      repository: workspaceId, // Map workspace to repository
      path: pageId, // Map pageId to path
      updated_at: updatedAt,
    },
    content: {
      type: 'document',
      language: 'markdown', // Default language for Notion content
      size_bytes: sizeBytes,
    },
    ingestion: {
      timestamp: new Date().toISOString(),
      version: METADATA_VERSION,
    },
  };

  logger.debug(
    {
      event: 'notion_metadata_created',
      workspaceId,
      pageId,
      title,
      sizeBytes,
      requestId,
    },
    'Created Notion metadata object',
  );

  return metadata;
}

/**
 * Determines the content category based on the Notion page properties
 *
 * @param page - Notion page object
 * @returns ContentCategory
 */
export function determineCategory(page: NotionPage): ContentCategory {
  // Check if this is a database page
  if (page.parent?.type === 'database_id') {
    return 'database' as ContentCategory;
  }

  // Check for code blocks (would require analyzing blocks)
  // Default to document for most Notion pages
  return 'document' as ContentCategory;
}

/**
 * Determines the MIME type based on the page content
 *
 * @param page - Notion page object
 * @returns MimeType
 */
export function determineMimeType(page: NotionPage): MimeType {
  // Notion pages are typically formatted text
  return 'text/markdown' as MimeType;
}

/**
 * Convert Notion blocks to plain text
 *
 * @param blocks - Array of Notion blocks
 * @returns Plain text representation of the blocks
 */
export function blocksToText(blocks: NotionBlock[]): string {
  let text = '';

  for (const block of blocks) {
    const blockText = extractTextFromBlock(block);
    if (blockText) {
      text += blockText + '\n\n';
    }
  }

  return text.trim();
}

/**
 * Extract text content from a Notion block
 *
 * @param block - Notion block object
 * @returns Text content of the block
 */
export function extractTextFromBlock(block: NotionBlock): string {
  try {
    switch (block.type) {
      case 'paragraph':
        return extractRichText(block.paragraph?.rich_text || []);

      case 'heading_1':
        return `# ${extractRichText(block.heading_1?.rich_text || [])}`;

      case 'heading_2':
        return `## ${extractRichText(block.heading_2?.rich_text || [])}`;

      case 'heading_3':
        return `### ${extractRichText(block.heading_3?.rich_text || [])}`;

      case 'bulleted_list_item':
        return `• ${extractRichText(block.bulleted_list_item?.rich_text || [])}`;

      case 'numbered_list_item':
        return `1. ${extractRichText(block.numbered_list_item?.rich_text || [])}`;

      case 'to_do':
        const checked = block.to_do?.checked ? '[x]' : '[ ]';
        return `${checked} ${extractRichText(block.to_do?.rich_text || [])}`;

      case 'toggle':
        return `▶ ${extractRichText(block.toggle?.rich_text || [])}`;

      case 'code':
        const language = block.code?.language || '';
        return `\`\`\`${language}\n${extractRichText(block.code?.rich_text || [])}\n\`\`\``;

      case 'quote':
        return `> ${extractRichText(block.quote?.rich_text || [])}`;

      case 'callout':
        const emoji = block.callout?.icon?.emoji || '';
        return `${emoji} ${extractRichText(block.callout?.rich_text || [])}`;

      case 'divider':
        return '---';

      case 'table':
        // Tables require special handling with the children blocks
        return '[Table]';

      default:
        return '';
    }
  } catch (error) {
    logger.warn(
      {
        blockType: block.type,
        blockId: block.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'notion: error extracting text from block',
    );
    return '';
  }
}

/**
 * Extract plain text from Notion rich text objects
 *
 * @param richText - Array of rich text objects
 * @returns Plain text representation
 */
export function extractRichText(richText: any[]): string {
  if (!Array.isArray(richText)) return '';

  return richText
    .map(textObj => {
      let text = textObj.plain_text || '';

      // Apply markdown-like formatting if available
      if (textObj.annotations) {
        if (textObj.annotations.bold) text = `**${text}**`;
        if (textObj.annotations.italic) text = `*${text}*`;
        if (textObj.annotations.strikethrough) text = `~~${text}~~`;
        if (textObj.annotations.code) text = `\`${text}\``;
      }

      // Add hyperlinks
      if (textObj.href) {
        text = `[${text}](${textObj.href})`;
      }

      return text;
    })
    .join('');
}

/**
 * Convert Notion database to structured text
 *
 * @param database - Notion database object
 * @param rows - Array of database rows (pages)
 * @returns Text representation of the database
 */
export function databaseToText(database: any, rows: any[]): string {
  try {
    let text = `# ${database.title || 'Untitled Database'}\n\n`;

    // Extract property names
    const properties = Object.keys(database.properties || {});
    if (properties.length === 0 || rows.length === 0) {
      return text + '[Empty Database]';
    }

    // Create table header
    text += '| ' + properties.join(' | ') + ' |\n';
    text += '| ' + properties.map(() => '---').join(' | ') + ' |\n';

    // Add rows
    for (const row of rows) {
      const rowValues = properties.map(prop => {
        const value = row.properties[prop];
        return extractPropertyValue(value);
      });

      text += '| ' + rowValues.join(' | ') + ' |\n';
    }

    return text;
  } catch (error) {
    logger.warn(
      { databaseId: database.id, error: error instanceof Error ? error.message : String(error) },
      'notion: error converting database to text',
    );
    return `# ${database.title || 'Untitled Database'}\n\n[Database Conversion Error]`;
  }
}

/**
 * Extract value from a Notion property
 *
 * @param property - Notion property object
 * @returns String representation of the property value
 */
export function extractPropertyValue(property: any): string {
  if (!property) return '';

  try {
    switch (property.type) {
      case 'title':
      case 'rich_text':
        return extractRichText(property[property.type] || []);

      case 'number':
        return property.number?.toString() || '';

      case 'select':
        return property.select?.name || '';

      case 'multi_select':
        return (property.multi_select || []).map((item: any) => item.name).join(', ');

      case 'date':
        const start = property.date?.start || '';
        const end = property.date?.end ? ` - ${property.date.end}` : '';
        return start + end;

      case 'people':
        return (property.people || []).map((person: any) => person.name || person.id).join(', ');

      case 'checkbox':
        return property.checkbox ? '✓' : '✗';

      case 'url':
        return property.url || '';

      case 'email':
        return property.email || '';

      case 'phone_number':
        return property.phone_number || '';

      case 'formula':
        return (
          property.formula?.string ||
          property.formula?.number?.toString() ||
          property.formula?.boolean?.toString() ||
          ''
        );

      default:
        return '[Unsupported Property]';
    }
  } catch (error) {
    logger.warn(
      {
        propertyType: property.type,
        error: error instanceof Error ? error.message : String(error),
      },
      'notion: error extracting property value',
    );
    return '[Error]';
  }
}

/**
 * Check if a page should be ignored based on filtering rules
 *
 * @param page - Notion page object
 * @returns Boolean indicating if the page should be ignored
 */
export function shouldIgnorePage(page: NotionPage): boolean {
  // Skip archived pages if that property exists
  if ('archived' in page && page.archived) return true;

  // Skip pages with specific tags (if implemented)

  // Default to including the page
  return false;
}
