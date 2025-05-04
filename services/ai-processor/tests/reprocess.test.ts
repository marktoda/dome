import { describe, it, expect, vi, beforeEach } from 'vitest';
import AiProcessor from '../src/index';
import { SiloContentMetadata } from '@dome/common';

// Mock the services
const mockLlmService = {
  processContent: vi.fn(),
};

const mockSiloClient = {
  get: vi.fn(),
  getMetadataById: vi.fn(),
  findContentWithFailedSummary: vi.fn(),
};

// Mock the environment
const mockEnv = {
  ENRICHED_CONTENT: {
    send: vi.fn(),
  },
  SILO: {},
  AI: {},
};

// Mock the logger
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  logError: vi.fn(),
  withLogger: vi.fn().mockImplementation((_, fn) => fn()),
  metrics: {
    increment: vi.fn(),
    timing: vi.fn(),
  },
}));

// Mock the services
vi.mock('../src/services/llmService', () => ({
  createLlmService: () => mockLlmService,
}));

// Mock SiloClient
vi.mock('@dome/silo/client', () => ({
  SiloClient: vi.fn().mockImplementation(() => mockSiloClient),
}));

describe('AiProcessor - Reprocess RPC Function', () => {
  let aiProcessor: AiProcessor;
  let mockExecutionContext: ExecutionContext;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create a new instance for each test
    mockExecutionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} };
    aiProcessor = new AiProcessor(mockExecutionContext, mockEnv as any);

    // Default mock implementations
    mockLlmService.processContent.mockResolvedValue({
      title: 'Test Title',
      summary: 'Test summary.',
      processingVersion: 1,
      modelUsed: '@cf/google/gemma-7b-it-lora',
    });

    mockSiloClient.get.mockResolvedValue({
      id: 'test-id',
      body: 'Test content',
    });

    mockSiloClient.getMetadataById.mockResolvedValue({
      id: 'test-id',
      userId: 'test-user',
      category: 'note',
      mimeType: 'text/markdown',
      size: 100,
      r2Key: 'content/test-id',
      createdAt: Date.now(),
      version: 1,
    });

    mockEnv.ENRICHED_CONTENT.send.mockResolvedValue(undefined);
  });

  describe('reprocess', () => {
    it('should reprocess content by ID successfully', async () => {
      const result = await aiProcessor.reprocess({ id: 'test-id' });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('reprocessed');
      expect(result.reprocessed).toHaveProperty('id', 'test-id');
      expect(result.reprocessed).toHaveProperty('success', true);

      // Verify that the content was fetched and processed
      expect(mockSiloClient.getMetadataById).toHaveBeenCalledWith('test-id');
      expect(mockSiloClient.get).toHaveBeenCalledWith('test-id', 'test-user');
      expect(mockLlmService.processContent).toHaveBeenCalledWith('Test content', 'note');
      expect(mockEnv.ENRICHED_CONTENT.send).toHaveBeenCalled();
    });

    it('should handle content not found', async () => {
      mockSiloClient.getMetadataById.mockResolvedValue(null);

      await expect(aiProcessor.reprocess({ id: 'non-existent-id' })).rejects.toThrow();
    });

    it('should reprocess all failed content when no ID is provided', async () => {
      // Mock failed content
      const failedContent: SiloContentMetadata[] = [
        {
          id: 'failed-1',
          userId: 'test-user',
          category: 'note' as any,
          mimeType: 'text/markdown' as any,
          size: 100,
          r2Key: 'content/failed-1',
          createdAt: Date.now(),
          version: 1,
          summary: 'Content processing failed',
        },
        {
          id: 'failed-2',
          userId: 'test-user',
          category: 'note' as any,
          mimeType: 'text/markdown' as any,
          size: 100,
          r2Key: 'content/failed-2',
          createdAt: Date.now(),
          version: 1,
          summary: undefined,
        },
      ];

      mockSiloClient.findContentWithFailedSummary.mockResolvedValue(failedContent);
      mockSiloClient.get.mockImplementation(id => ({
        id,
        body: `Content for ${id}`,
      }));

      const result = await aiProcessor.reprocess({});

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('reprocessed');
      expect(result.reprocessed).toHaveProperty('total', 2);
      expect(result.reprocessed).toHaveProperty('successful', 2);

      // Verify that findContentWithFailedSummary was called
      expect(mockSiloClient.findContentWithFailedSummary).toHaveBeenCalled();

      // Verify that each content was processed
      expect(mockSiloClient.get).toHaveBeenCalledTimes(2);
      expect(mockLlmService.processContent).toHaveBeenCalledTimes(2);
      expect(mockEnv.ENRICHED_CONTENT.send).toHaveBeenCalledTimes(2);
    });

    it('should handle errors during reprocessing of all failed content', async () => {
      // Mock failed content
      const failedContent: SiloContentMetadata[] = [
        {
          id: 'failed-1',
          userId: 'test-user',
          category: 'note' as any,
          mimeType: 'text/markdown' as any,
          size: 100,
          r2Key: 'content/failed-1',
          createdAt: Date.now(),
          version: 1,
          summary: 'Content processing failed',
        },
        {
          id: 'failed-2',
          userId: 'test-user',
          category: 'note' as any,
          mimeType: 'text/markdown' as any,
          size: 100,
          r2Key: 'content/failed-2',
          createdAt: Date.now(),
          version: 1,
          summary: undefined,
        },
      ];

      mockSiloClient.findContentWithFailedSummary.mockResolvedValue(failedContent);

      // Make the first content processing fail
      mockSiloClient.get.mockImplementation(id => {
        if (id === 'failed-1') {
          throw new Error('Failed to get content');
        }
        return {
          id,
          body: `Content for ${id}`,
        };
      });

      const result = await aiProcessor.reprocess({});

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('reprocessed');
      expect(result.reprocessed).toHaveProperty('total', 2);
      expect(result.reprocessed).toHaveProperty('successful', 1); // Only one succeeded

      // Verify that findContentWithFailedSummary was called
      expect(mockSiloClient.findContentWithFailedSummary).toHaveBeenCalled();

      // Verify that each content was processed
      expect(mockSiloClient.get).toHaveBeenCalledTimes(2);
      expect(mockLlmService.processContent).toHaveBeenCalledTimes(1); // Only one succeeded
      expect(mockEnv.ENRICHED_CONTENT.send).toHaveBeenCalledTimes(1); // Only one succeeded
    });

    it('should handle validation errors', async () => {
      // @ts-ignore - Testing invalid input
      await expect(aiProcessor.reprocess({ id: 123 })).rejects.toThrow();
    });
  });
});
