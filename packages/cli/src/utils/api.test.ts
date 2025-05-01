// @ts-nocheck
import axios from 'axios';
import { describe, beforeEach, test, expect, vi, afterEach } from 'vitest';
import {
  addContent,
  addNote,
  listItems,
  showItem,
  search,
  chat,
  resetApiInstance,
  api,
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

// Mock WebSocket
vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn()
  }))
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

  test('should use API client with authentication headers', () => {
    // Create a new axios instance and check if interceptors are correctly set up
    resetApiInstance();
    
    // Force creation of a new API client by making a call
    api.get('/test');
    
    // Verify that axios.create was called with correct base URL
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: 'http://localhost:8787',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    // Verify request interceptor adds authentication headers
    const requestInterceptor = mockedAxios.create().interceptors.request.use.mock.calls[0][0];
    const config = { headers: {} };
    const result = requestInterceptor(config);
    
    expect(result.headers).toHaveProperty('Authorization', 'Bearer test-api-key');
    expect(result.headers).toHaveProperty('x-api-key', 'test-api-key');
    expect(result.headers).toHaveProperty('x-user-id', 'test-user-id');
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

    expect(mockGet).toHaveBeenCalled();
    const [url, params] = mockGet.mock.calls[0];
    expect(url).toBe('/notes');
    expect(params).toHaveProperty('params');
    expect(params.params).toHaveProperty('contentType', 'tag:work');
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

    expect(mockGet).toHaveBeenCalled();
    const [url] = mockGet.mock.calls[0];
    expect(url).toBe('/notes/123');
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

    expect(mockGet).toHaveBeenCalled();
    const [url, params] = mockGet.mock.calls[0];
    expect(url).toBe('/search');
    expect(params).toHaveProperty('params');
    expect(params.params).toHaveProperty('q', 'test query');
    expect(params.params).toHaveProperty('limit', 10);
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

    expect(mockPost).toHaveBeenCalled();
    const [url, data] = mockPost.mock.calls[0];
    expect(url).toBe('/chat');
    expect(data).toHaveProperty('userId', 'test-user-id');
    expect(data).toHaveProperty('messages');
    expect(data.messages[0]).toHaveProperty('role', 'user');
    expect(data.messages[0]).toHaveProperty('content', 'hello');
    expect(data).toHaveProperty('stream', false);
    expect(data).toHaveProperty('auth');
    expect(data.auth).toHaveProperty('token', mockConfig.apiKey);
  });
});
