// @ts-nocheck
import { describe, beforeEach, test, expect, vi } from 'vitest';
import type { ConfigSchema } from './config';

// Define mock functions at a scope accessible by beforeEach and top-level vi.mock
let mockGetApiClient = vi.fn();
let mockClearApiClientInstance = vi.fn();
const mockLoadConfig = vi.fn();

// Top-level mock for the actual './apiClient' module
vi.mock('./apiClient', () => ({
  getApiClient: mockGetApiClient,
  clearApiClientInstance: mockClearApiClientInstance,
}));

// Top-level mock for './config'
vi.mock('./config', () => ({
  loadConfig: mockLoadConfig,
  isAuthenticated: vi.fn().mockReturnValue(true), // Default mock for other functions if needed
  saveApiKey: vi.fn(),
}));

// Top-level mock for 'ws'
vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  })),
}));

// This will hold the dynamically imported module
let apiModule: typeof import('./api');

// Define a reusable mock DomeApiClient structure. These are vi.fn() so they are spies.
const mockDomeApiClient = {
  notes: {
    ingestANewNote: vi.fn(),
    listNotes: vi.fn(),
    getANoteById: vi.fn(),
  },
  search: {
    searchContent: vi.fn(),
  },
  chat: {
    sendAChatMessage: vi.fn(),
  },
};

describe('API wrapper functions', () => {
  const mockConfigValue: ConfigSchema = {
    baseUrl: 'http://localhost:8787',
    apiKey: 'test-api-key',
    environment: 'development',
  };

  beforeEach(async () => {
    // 1. Reset all mocks to clear state from previous tests (call counts, etc.)
    vi.clearAllMocks();

    // 2. Configure our module-scoped mock functions for this specific test run
    //    These mocks are defined at the top level and are used by the vi.mock factories.
    mockGetApiClient.mockReturnValue(mockDomeApiClient);
    // mockClearApiClientInstance is already a vi.fn(), clearAllMocks resets its call history.
    mockLoadConfig.mockReturnValue(mockConfigValue);

    // 3. Reset modules: This clears the cache, so the next import of './api' will be fresh
    //    and will use the mocks we've just configured for its dependencies.
    vi.resetModules();

    // 4. Dynamically import the module under test. It will now use the fresh mocks.
    apiModule = await import('./api');

    // 5. Set up resolved values for the methods on mockDomeApiClient for this test
    //    apiModule.api should now BE mockDomeApiClient due to the mocking of getApiClient.
    if (!apiModule || !apiModule.api) {
      throw new Error(
        'apiModule or apiModule.api is not defined after dynamic import. Check mocks for ./apiClient and export of api in ./api.ts',
      );
    }
    // Ensure the methods on the mock client are configured for this test
    mockDomeApiClient.notes.ingestANewNote.mockResolvedValue({ data: { success: true } } as any);
    mockDomeApiClient.notes.listNotes.mockResolvedValue({ data: { items: [] } } as any);
    mockDomeApiClient.notes.getANoteById.mockResolvedValue({ data: { id: '123' } } as any);
    mockDomeApiClient.search.searchContent.mockResolvedValue({ data: { matches: [] } } as any);
    mockDomeApiClient.chat.sendAChatMessage.mockResolvedValue({
      data: { message: 'response' },
    } as any);

    // 6. Call resetApiInstance from the dynamically imported module.
    //    This should call the mocked clearApiClientInstance.
    if (typeof apiModule.resetApiInstance !== 'function') {
      throw new Error(
        'apiModule.resetApiInstance is not a function or apiModule is not loaded correctly',
      );
    }
    apiModule.resetApiInstance();
  });

  test('addContent should call notes.ingestANewNote with the correct parameters', async () => {
    await apiModule.addContent('test content', 'Test Title', ['tag1']);
    expect(mockDomeApiClient.notes.ingestANewNote).toHaveBeenCalledWith({
      content: 'test content',
      mimeType: 'text/plain',
      title: 'Test Title',
      category: 'tag1',
    });
  });

  test('addNote should call notes.ingestANewNote with the correct parameters', async () => {
    await apiModule.addNote('meeting', 'test note');
    expect(mockDomeApiClient.notes.ingestANewNote).toHaveBeenCalledWith({
      content: 'test note',
      mimeType: 'text/plain',
      category: 'meeting',
    });
  });

  test('listItems should call notes.listNotes with the correct parameters', async () => {
    await apiModule.listItems('notes', 'work_category');
    expect(mockDomeApiClient.notes.listNotes).toHaveBeenCalledWith({ category: 'work_category' });
  });

  test('showItem should call notes.getANoteById with the correct parameters', async () => {
    await apiModule.showItem('123');
    expect(mockDomeApiClient.notes.getANoteById).toHaveBeenCalledWith('123');
  });

  test('search should call search.searchContent with the correct parameters', async () => {
    await apiModule.search('test query', 15);
    expect(mockDomeApiClient.search.searchContent).toHaveBeenCalledWith({
      q: 'test query',
      limit: 15,
    });
  });

  test('chat should call chat.sendAChatMessage with the correct parameters', async () => {
    await apiModule.chat('hello', 'user123', true);
    expect(mockDomeApiClient.chat.sendAChatMessage).toHaveBeenCalledWith({
      userId: 'user123',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      options: {},
    });
  });
});
