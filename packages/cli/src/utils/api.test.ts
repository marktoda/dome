// @ts-nocheck
import axios from 'axios';
import { describe, beforeEach, test, expect, vi, afterEach } from 'vitest';
import {
  ApiClient,
  addContent,
  addNote,
  listItems,
  showItem,
  search,
  chat,
  resetApiInstance,
  getApiInstance,
} from './api';
import { loadConfig, saveApiKey } from './config';
import type { ConfigSchema } from './config';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

// Mock config
vi.mock('./config', () => ({
  loadConfig: vi.fn(),
  isAuthenticated: vi.fn().mockReturnValue(true),
  saveApiKey: vi.fn(),
}));

describe('ApiClient', () => {
  const mockConfig: ConfigSchema = {
    baseUrl: 'http://localhost:8787',
    apiKey: 'test-api-key',
    environment: 'development',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetApiInstance();
    (loadConfig as any).mockReturnValue(mockConfig);

    mockedAxios.create.mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: {} }),
      post: vi.fn().mockResolvedValue({ data: {} }),
      put: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);
  });

  test('should create an instance with the correct base URL', () => {
    new ApiClient(mockConfig);
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: 'http://localhost:8787',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  });

  test('addContent should call post with the correct parameters', async () => {
    const mockPost = vi.fn().mockResolvedValue({ data: { success: true } });
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);

    await addContent('test content');

    expect(mockPost).toHaveBeenCalledWith(
      '/notes',
      {
        content: 'test content',
        contentType: 'text/plain',
        title: undefined,
        tags: undefined,
      },
      undefined,
    );
  });

  test('addNote should call post with the correct parameters', async () => {
    const mockPost = vi.fn().mockResolvedValue({ data: { success: true } });
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);

    await addNote('meeting', 'test note');

    expect(mockPost).toHaveBeenCalledWith(
      '/notes',
      {
        content: 'test note',
        contentType: 'text/plain',
        metadata: { context: 'meeting' },
      },
      undefined,
    );
  });

  test('listItems should call get with the correct parameters', async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: { items: [] } });
    mockedAxios.create.mockReturnValue({
      get: mockGet,
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);

    await listItems('notes', 'tag:work');

    expect(mockGet).toHaveBeenCalledWith('/notes', { params: { contentType: 'tag:work' } });
  });

  test('showItem should call get with the correct parameters', async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: { id: '123' } });
    mockedAxios.create.mockReturnValue({
      get: mockGet,
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);

    await showItem('123');

    expect(mockGet).toHaveBeenCalledWith('/notes/123', undefined);
  });

  test('search should call get with the correct parameters', async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: { matches: [] } });
    mockedAxios.create.mockReturnValue({
      get: mockGet,
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);

    await search('test query');

    expect(mockGet).toHaveBeenCalledWith('/search', {
      params: { q: 'test query', limit: 10 },
    });
  });

  test('chat should call post with the correct parameters', async () => {
    const mockPost = vi.fn().mockResolvedValue({ data: { message: 'response' } });
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      interceptors: {
        request: {
          use: vi.fn(),
        },
      },
    } as any);

    await chat('hello');

    expect(mockPost).toHaveBeenCalledWith(
      '/chat',
      {
        initialState: {
          userId: 'cli-user',
          messages: [{ role: 'user', content: 'hello', timestamp: expect.any(Number) }],
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      },
      undefined,
    );
  });
});
