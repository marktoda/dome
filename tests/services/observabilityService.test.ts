vi.mock('@dome/common', async () => {
  const actual = await vi.importActual('@dome/common');
  return {
    ...actual as object,
    countTokens: vi.fn().mockImplementation((text: string) => Math.ceil(text.length / 4)),
    MetricsService: vi.fn(() => ({
      increment: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
    })),
    ContentCategoryEnum: {
      enum: {
        document: 'document',
        code: 'code',
        note: 'note',
        // Add other enum values as needed by tests
      },
    },
    DEFAULT_CONTEXT_ALLOCATION: {
        maxPerDocumentPercentage: 0.1,
        documentsPercentage: 0.5, 
    },
    getDefaultModel: vi.fn(() => ({ id: 'test-model', maxContextTokens: 4000 })),
    // Add other common mocks if they surface as missing
  };
}); 