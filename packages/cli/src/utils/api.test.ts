// @ts-nocheck
import axios from 'axios';
import { ApiClient, addContent, addNote, listItems, showItem, search, chat, resetApiInstance, getApiInstance } from './api';
import { loadConfig, saveApiKey } from './config';
import type { ConfigSchema } from './config';

// Add Jest types
declare global {
  namespace jest {
    interface Matchers<R> {
      toHaveBeenCalledWith: (...args: any[]) => R;
    }
    type Mock<T = any, Y extends any[] = any> = {
      (...args: Y): T;
      mockReturnValue: (val: T) => Mock<T, Y>;
      mockResolvedValue: (val: T) => Mock<Promise<T>, Y>;
      mockImplementation: (fn: (...args: Y) => T) => Mock<T, Y>;
    };
    type Mocked<T> = {
      [P in keyof T]: T[P] extends (...args: infer A) => infer B
        ? jest.Mock<B, A>
        : T[P];
    };
  }

  function describe(name: string, fn: () => void): void;
  function beforeEach(fn: () => void): void;
  function test(name: string, fn: () => void): void;
  function expect<T>(value: T): any;
}

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock config
jest.mock('./config', () => ({
  loadConfig: jest.fn(),
  isAuthenticated: jest.fn().mockReturnValue(true),
  saveApiKey: jest.fn(),
}));

describe('ApiClient', () => {
  const mockConfig: ConfigSchema = {
    baseUrl: 'http://localhost:8787',
    apiKey: 'test-api-key',
    environment: 'development',
  };
  
  beforeEach(() => {
    jest.clearAllMocks();
    resetApiInstance();
    (loadConfig as jest.Mock).mockReturnValue(mockConfig);
    
    mockedAxios.create.mockReturnValue({
      get: jest.fn().mockResolvedValue({ data: {} }),
      post: jest.fn().mockResolvedValue({ data: {} }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
      interceptors: {
        request: {
          use: jest.fn(),
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
    const mockPost = jest.fn().mockResolvedValue({ data: { success: true } });
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    } as any);

    await addContent('test content');
    
    expect(mockPost).toHaveBeenCalledWith('/ingest', { content: 'test content' }, undefined);
  });

  test('addNote should call post with the correct parameters', async () => {
    const mockPost = jest.fn().mockResolvedValue({ data: { success: true } });
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    } as any);

    await addNote('meeting', 'test note');
    
    expect(mockPost).toHaveBeenCalledWith('/note/meeting', { content: 'test note' }, undefined);
  });

  test('listItems should call get with the correct parameters', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: { items: [] } });
    mockedAxios.create.mockReturnValue({
      get: mockGet,
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    } as any);

    await listItems('notes', 'tag:work');
    
    expect(mockGet).toHaveBeenCalledWith('/list/notes', { params: { filter: 'tag:work' } });
  });

  test('showItem should call get with the correct parameters', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: { id: '123' } });
    mockedAxios.create.mockReturnValue({
      get: mockGet,
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    } as any);

    await showItem('123');
    
    expect(mockGet).toHaveBeenCalledWith('/show/123', undefined);
  });

  test('search should call get with the correct parameters', async () => {
    const mockGet = jest.fn().mockResolvedValue({ data: { matches: [] } });
    mockedAxios.create.mockReturnValue({
      get: mockGet,
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    } as any);

    await search('test query');
    
    expect(mockGet).toHaveBeenCalledWith('/search', { params: { q: 'test query' } });
  });

  test('chat should call post with the correct parameters', async () => {
    const mockPost = jest.fn().mockResolvedValue({ data: { message: 'response' } });
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    } as any);

    await chat('hello');
    
    expect(mockPost).toHaveBeenCalledWith('/chat', { message: 'hello' }, undefined);
  });
});