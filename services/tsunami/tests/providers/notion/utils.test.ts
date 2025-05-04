import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createNotionMetadata,
  determineCategory,
  determineMimeType,
  blocksToText,
  extractTextFromBlock,
  extractRichText,
  databaseToText,
  extractPropertyValue,
  shouldIgnorePage,
} from '../../../src/providers/notion/utils';
import { NotionBlock, NotionPage } from '../../../src/providers/notion/client';
import { ValidationError } from '@dome/common/src/errors';

// Mock logger and request ID
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getRequestId: vi.fn().mockReturnValue('test-request-id'),
}));

describe('Notion Utils', () => {
  describe('createNotionMetadata', () => {
    it('should create valid metadata for Notion content', () => {
      const workspaceId = 'workspace-123';
      const pageId = 'page-456';
      const updatedAt = '2023-04-30T12:00:00Z';
      const title = 'Test Document';
      const sizeBytes = 1024;

      const metadata = createNotionMetadata(workspaceId, pageId, updatedAt, title, sizeBytes);

      expect(metadata).toEqual({
        source: {
          type: 'notion',
          repository: workspaceId,
          path: pageId,
          updated_at: updatedAt,
        },
        content: {
          type: 'document',
          language: 'markdown',
          size_bytes: sizeBytes,
        },
        ingestion: {
          timestamp: expect.any(String),
          version: '1.0',
        },
      });
    });

    it('should validate input parameters', () => {
      // Empty workspace ID
      expect(() => {
        createNotionMetadata('', 'page-456', '2023-04-30T12:00:00Z', 'Title', 100);
      }).toThrow(ValidationError);

      // Empty page ID
      expect(() => {
        createNotionMetadata('workspace-123', '', '2023-04-30T12:00:00Z', 'Title', 100);
      }).toThrow(ValidationError);

      // Empty updated at
      expect(() => {
        createNotionMetadata('workspace-123', 'page-456', '', 'Title', 100);
      }).toThrow(ValidationError);

      // Negative size
      expect(() => {
        createNotionMetadata('workspace-123', 'page-456', '2023-04-30T12:00:00Z', 'Title', -1);
      }).toThrow(ValidationError);
    });

    it('should allow empty title', () => {
      // Empty title should be allowed
      const metadata = createNotionMetadata(
        'workspace-123',
        'page-456',
        '2023-04-30T12:00:00Z',
        '',
        100,
      );

      expect(metadata).toBeDefined();
    });
  });

  describe('determineCategory', () => {
    it('should identify database pages', () => {
      const databasePage: NotionPage = {
        id: 'page-123',
        title: 'Database Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'database_id',
          database_id: 'db-123',
        },
        properties: {},
      };

      expect(determineCategory(databasePage)).toBe('database');
    });

    it('should identify regular document pages', () => {
      const documentPage: NotionPage = {
        id: 'page-123',
        title: 'Document Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'page_id',
          page_id: 'parent-123',
        },
        properties: {},
      };

      expect(determineCategory(documentPage)).toBe('document');
    });

    it('should identify workspace root pages', () => {
      const rootPage: NotionPage = {
        id: 'page-123',
        title: 'Root Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'workspace',
          workspace: true,
        },
        properties: {},
      };

      expect(determineCategory(rootPage)).toBe('document');
    });
  });

  describe('determineMimeType', () => {
    it('should return markdown mime type for Notion pages', () => {
      const page: NotionPage = {
        id: 'page-123',
        title: 'Test Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'workspace',
          workspace: true,
        },
        properties: {},
      };

      expect(determineMimeType(page)).toBe('text/markdown');
    });
  });

  describe('blocksToText', () => {
    it('should convert blocks to plain text', () => {
      const blocks: NotionBlock[] = [
        {
          id: 'block-1',
          type: 'paragraph',
          has_children: false,
          paragraph: {
            rich_text: [{ plain_text: 'This is a paragraph.' }],
          },
        },
        {
          id: 'block-2',
          type: 'heading_1',
          has_children: false,
          heading_1: {
            rich_text: [{ plain_text: 'This is a heading' }],
          },
        },
      ];

      const text = blocksToText(blocks);
      expect(text).toContain('This is a paragraph.');
      expect(text).toContain('# This is a heading');
    });

    it('should handle empty blocks array', () => {
      expect(blocksToText([])).toBe('');
    });

    it('should skip blocks with errors', () => {
      const blocks: NotionBlock[] = [
        {
          id: 'block-1',
          type: 'paragraph',
          has_children: false,
          paragraph: {
            rich_text: [{ plain_text: 'Valid block' }],
          },
        },
        {
          id: 'block-2',
          type: 'invalid_type', // This will cause an error
          has_children: false,
        } as any,
      ];

      const text = blocksToText(blocks);
      expect(text).toBe('Valid block');

      // Log warning should be called for the invalid block
      const logger = require('@dome/common').getLogger();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle empty rich_text arrays', () => {
      const blocks: NotionBlock[] = [
        {
          id: 'block-1',
          type: 'paragraph',
          has_children: false,
          paragraph: {
            rich_text: [], // Empty array
          },
        },
      ];

      const text = blocksToText(blocks);
      expect(text).toBe('');
    });

    it('should handle undefined blocks gracefully', () => {
      const blocks: (NotionBlock | undefined)[] = [
        undefined,
        {
          id: 'block-1',
          type: 'paragraph',
          has_children: false,
          paragraph: {
            rich_text: [{ plain_text: 'Valid block' }],
          },
        },
      ];

      // @ts-ignore - Testing runtime behavior with undefined
      const text = blocksToText(blocks);
      expect(text).toBe('Valid block');
    });
  });

  describe('extractTextFromBlock', () => {
    it('should extract text from paragraph block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'paragraph',
        has_children: false,
        paragraph: {
          rich_text: [{ plain_text: 'This is a paragraph.' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('This is a paragraph.');
    });

    it('should extract text from heading_1 block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'heading_1',
        has_children: false,
        heading_1: {
          rich_text: [{ plain_text: 'This is a heading' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('# This is a heading');
    });

    it('should extract text from heading_2 block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'heading_2',
        has_children: false,
        heading_2: {
          rich_text: [{ plain_text: 'This is a subheading' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('## This is a subheading');
    });

    it('should extract text from heading_3 block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'heading_3',
        has_children: false,
        heading_3: {
          rich_text: [{ plain_text: 'This is a sub-subheading' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('### This is a sub-subheading');
    });

    it('should extract text from bulleted_list_item block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'bulleted_list_item',
        has_children: false,
        bulleted_list_item: {
          rich_text: [{ plain_text: 'Bullet point' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('• Bullet point');
    });

    it('should extract text from numbered_list_item block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'numbered_list_item',
        has_children: false,
        numbered_list_item: {
          rich_text: [{ plain_text: 'Numbered point' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('1. Numbered point');
    });

    it('should extract text from to_do block', () => {
      const uncheckedBlock: NotionBlock = {
        id: 'block-1',
        type: 'to_do',
        has_children: false,
        to_do: {
          rich_text: [{ plain_text: 'Task to do' }],
          checked: false,
        },
      };

      const checkedBlock: NotionBlock = {
        id: 'block-2',
        type: 'to_do',
        has_children: false,
        to_do: {
          rich_text: [{ plain_text: 'Completed task' }],
          checked: true,
        },
      };

      expect(extractTextFromBlock(uncheckedBlock)).toBe('[ ] Task to do');
      expect(extractTextFromBlock(checkedBlock)).toBe('[x] Completed task');
    });

    it('should extract text from toggle block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'toggle',
        has_children: true,
        toggle: {
          rich_text: [{ plain_text: 'Toggle content' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('▶ Toggle content');
    });

    it('should extract text from code block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'code',
        has_children: false,
        code: {
          rich_text: [{ plain_text: 'const x = 1;' }],
          language: 'javascript',
        },
      };

      expect(extractTextFromBlock(block)).toBe('```javascript\nconst x = 1;\n```');
    });

    it('should extract text from quote block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'quote',
        has_children: false,
        quote: {
          rich_text: [{ plain_text: 'This is a quote' }],
        },
      };

      expect(extractTextFromBlock(block)).toBe('> This is a quote');
    });

    it('should extract text from callout block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'callout',
        has_children: false,
        callout: {
          rich_text: [{ plain_text: 'Callout text' }],
          icon: { emoji: '💡' },
        },
      };

      expect(extractTextFromBlock(block)).toBe('💡 Callout text');
    });

    it('should extract text from divider block', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'divider',
        has_children: false,
      };

      expect(extractTextFromBlock(block)).toBe('---');
    });

    it('should handle table block placeholder', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'table',
        has_children: true,
      };

      expect(extractTextFromBlock(block)).toBe('[Table]');
    });

    it('should return empty string for unsupported block types', () => {
      const block: NotionBlock = {
        id: 'block-1',
        type: 'unsupported',
        has_children: false,
      };

      expect(extractTextFromBlock(block)).toBe('');
    });

    it('should handle errors gracefully', () => {
      const malformedBlock: NotionBlock = {
        id: 'block-1',
        type: 'paragraph',
        has_children: false,
        // Missing paragraph property
      };

      expect(extractTextFromBlock(malformedBlock)).toBe('');

      // Also test with null or undefined values
      expect(extractTextFromBlock(null as any)).toBe('');
      expect(extractTextFromBlock(undefined as any)).toBe('');

      // The function should log a warning
      const logger = require('@dome/common').getLogger();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should gracefully handle block with missing rich_text', () => {
      const blockWithMissingRichText: NotionBlock = {
        id: 'block-1',
        type: 'paragraph',
        has_children: false,
        paragraph: {}, // Missing rich_text property
      };

      expect(extractTextFromBlock(blockWithMissingRichText)).toBe('');
    });
  });

  describe('extractRichText', () => {
    it('should combine plain text from multiple rich text objects', () => {
      const richText = [{ plain_text: 'Hello ' }, { plain_text: 'World' }];

      expect(extractRichText(richText)).toBe('Hello World');
    });

    it('should handle empty array', () => {
      expect(extractRichText([])).toBe('');
    });

    it('should handle non-array input', () => {
      expect(extractRichText(null as any)).toBe('');
      expect(extractRichText(undefined as any)).toBe('');
      expect(extractRichText({} as any)).toBe('');
      expect(extractRichText('string' as any)).toBe('');
      expect(extractRichText(123 as any)).toBe('');
    });

    it('should safely handle rich text objects with missing properties', () => {
      const richText = [
        {
          /* missing plain_text */
        },
        { plain_text: 'Text' },
      ] as any;

      expect(extractRichText(richText)).toBe('Text');
    });

    it('should apply bold formatting', () => {
      const richText = [{ plain_text: 'Bold', annotations: { bold: true } }];

      expect(extractRichText(richText)).toBe('**Bold**');
    });

    it('should apply italic formatting', () => {
      const richText = [{ plain_text: 'Italic', annotations: { italic: true } }];

      expect(extractRichText(richText)).toBe('*Italic*');
    });

    it('should apply strikethrough formatting', () => {
      const richText = [{ plain_text: 'Strikethrough', annotations: { strikethrough: true } }];

      expect(extractRichText(richText)).toBe('~~Strikethrough~~');
    });

    it('should apply code formatting', () => {
      const richText = [{ plain_text: 'Code', annotations: { code: true } }];

      expect(extractRichText(richText)).toBe('`Code`');
    });

    it('should handle hyperlinks', () => {
      const richText = [
        {
          plain_text: 'Link',
          href: 'https://example.com',
        },
      ];

      expect(extractRichText(richText)).toBe('[Link](https://example.com)');
    });

    it('should apply multiple formatting options', () => {
      const richText = [
        {
          plain_text: 'Text',
          annotations: {
            bold: true,
            italic: true,
          },
        },
      ];

      expect(extractRichText(richText)).toBe('***Text***');
    });
  });

  describe('databaseToText', () => {
    it('should format database as markdown table', () => {
      const database = {
        id: 'db-123',
        title: 'Test Database',
        properties: {
          Name: { type: 'title' },
          Age: { type: 'number' },
          Status: { type: 'select' },
        },
      };

      const rows = [
        {
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'John' }] },
            Age: { type: 'number', number: 30 },
            Status: { type: 'select', select: { name: 'Active' } },
          },
        },
        {
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Jane' }] },
            Age: { type: 'number', number: 25 },
            Status: { type: 'select', select: { name: 'Inactive' } },
          },
        },
      ];

      const result = databaseToText(database, rows);

      // Should include title
      expect(result).toContain('# Test Database');

      // Should have headers
      expect(result).toContain('| Name | Age | Status |');
      expect(result).toContain('| --- | --- | --- |');

      // Should include data rows
      expect(result).toContain('| John | 30 | Active |');
      expect(result).toContain('| Jane | 25 | Inactive |');
    });

    it('should handle empty database', () => {
      const database = {
        id: 'db-123',
        title: 'Empty Database',
        properties: {},
      };

      const rows: any[] = [];

      const result = databaseToText(database, rows);
      expect(result).toContain('# Empty Database');
      expect(result).toContain('[Empty Database]');
    });

    it('should handle database with properties but no rows', () => {
      const database = {
        id: 'db-123',
        title: 'Database With No Rows',
        properties: {
          Name: { type: 'title' },
          Age: { type: 'number' },
        },
      };

      const rows: any[] = [];

      const result = databaseToText(database, rows);
      expect(result).toContain('# Database With No Rows');
      expect(result).toContain('[Empty Database]');
    });

    it('should handle errors gracefully', () => {
      const malformedDatabase = {
        id: 'db-123',
        // Missing title
        properties: null, // Will cause error
      };

      const rows = [{ properties: { Name: { type: 'title', title: [{ plain_text: 'John' }] } } }];

      const result = databaseToText(malformedDatabase, rows);
      expect(result).toContain('# Untitled Database');
      expect(result).toContain('[Database Conversion Error]');
    });
  });

  describe('extractPropertyValue', () => {
    it('should extract title property', () => {
      const property = {
        type: 'title',
        title: [{ plain_text: 'Title ' }, { plain_text: 'Text' }],
      };

      expect(extractPropertyValue(property)).toBe('Title Text');
    });

    it('should extract rich_text property', () => {
      const property = {
        type: 'rich_text',
        rich_text: [{ plain_text: 'Rich ' }, { plain_text: 'Text' }],
      };

      expect(extractPropertyValue(property)).toBe('Rich Text');
    });

    it('should extract number property', () => {
      const property = {
        type: 'number',
        number: 42,
      };

      expect(extractPropertyValue(property)).toBe('42');
    });

    it('should extract select property', () => {
      const property = {
        type: 'select',
        select: {
          name: 'Option 1',
        },
      };

      expect(extractPropertyValue(property)).toBe('Option 1');
    });

    it('should extract multi_select property', () => {
      const property = {
        type: 'multi_select',
        multi_select: [{ name: 'Tag 1' }, { name: 'Tag 2' }],
      };

      expect(extractPropertyValue(property)).toBe('Tag 1, Tag 2');
    });

    it('should extract date property', () => {
      const property = {
        type: 'date',
        date: {
          start: '2023-01-01',
        },
      };

      expect(extractPropertyValue(property)).toBe('2023-01-01');
    });

    it('should extract date range property', () => {
      const property = {
        type: 'date',
        date: {
          start: '2023-01-01',
          end: '2023-01-31',
        },
      };

      expect(extractPropertyValue(property)).toBe('2023-01-01 - 2023-01-31');
    });

    it('should extract people property', () => {
      const property = {
        type: 'people',
        people: [
          { name: 'John', id: 'user-1' },
          { id: 'user-2' }, // Missing name
        ],
      };

      expect(extractPropertyValue(property)).toBe('John, user-2');
    });

    it('should extract checkbox property', () => {
      const checkedProperty = {
        type: 'checkbox',
        checkbox: true,
      };

      const uncheckedProperty = {
        type: 'checkbox',
        checkbox: false,
      };

      expect(extractPropertyValue(checkedProperty)).toBe('✓');
      expect(extractPropertyValue(uncheckedProperty)).toBe('✗');
    });

    it('should extract url property', () => {
      const property = {
        type: 'url',
        url: 'https://example.com',
      };

      expect(extractPropertyValue(property)).toBe('https://example.com');
    });

    it('should extract email property', () => {
      const property = {
        type: 'email',
        email: 'test@example.com',
      };

      expect(extractPropertyValue(property)).toBe('test@example.com');
    });

    it('should extract phone_number property', () => {
      const property = {
        type: 'phone_number',
        phone_number: '+1234567890',
      };

      expect(extractPropertyValue(property)).toBe('+1234567890');
    });

    it('should extract formula property with string result', () => {
      const property = {
        type: 'formula',
        formula: {
          string: 'Calculated Value',
        },
      };

      expect(extractPropertyValue(property)).toBe('Calculated Value');
    });

    it('should extract formula property with number result', () => {
      const property = {
        type: 'formula',
        formula: {
          number: 42,
        },
      };

      expect(extractPropertyValue(property)).toBe('42');
    });

    it('should extract formula property with boolean result', () => {
      const property = {
        type: 'formula',
        formula: {
          boolean: true,
        },
      };

      expect(extractPropertyValue(property)).toBe('true');
    });

    it('should handle unsupported property types', () => {
      const property = {
        type: 'unsupported_type',
      };

      expect(extractPropertyValue(property)).toBe('[Unsupported Property]');
    });

    it('should handle null or undefined property', () => {
      expect(extractPropertyValue(null)).toBe('');
      expect(extractPropertyValue(undefined)).toBe('');
    });

    it('should handle errors gracefully', () => {
      const malformedProperty = {
        type: 'title',
        // Missing title array
      };

      expect(extractPropertyValue(malformedProperty)).toBe('[Error]');
    });
  });

  describe('shouldIgnorePage', () => {
    it('should ignore archived pages', () => {
      const archivedPage = {
        id: 'page-123',
        title: 'Archived Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'workspace',
          workspace: true,
        },
        properties: {},
        archived: true,
      } as NotionPage & { archived: boolean };

      expect(shouldIgnorePage(archivedPage)).toBe(true);
    });

    it('should not ignore non-archived pages', () => {
      const activePage = {
        id: 'page-123',
        title: 'Active Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'workspace',
          workspace: true,
        },
        properties: {},
        archived: false,
      } as NotionPage & { archived: boolean };

      expect(shouldIgnorePage(activePage)).toBe(false);
    });

    it('should not ignore pages without archive property', () => {
      const page: NotionPage = {
        id: 'page-123',
        title: 'Regular Page',
        url: 'https://notion.so/page-123',
        last_edited_time: '2023-04-30T12:00:00Z',
        parent: {
          type: 'workspace',
          workspace: true,
        },
        properties: {},
      };

      expect(shouldIgnorePage(page)).toBe(false);
    });
  });
});
