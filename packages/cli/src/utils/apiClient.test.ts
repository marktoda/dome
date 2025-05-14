import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getApiClient, clearApiClientInstance } from './apiClient';
import * as configModule from './config';
import { DomeApiClient } from '@dome/dome-sdk';
import { isAuthenticated, loadConfig } from './config';
import { ensureValidAccessToken } from './auth';

// Mock the DomeApiClient constructor
vi.mock('@dome/dome-sdk', () => {
  const DomeApiClientMock = vi.fn();
  DomeApiClientMock.prototype.someMethod = vi.fn(); // Example method if needed for deeper testing
  return { DomeApiClient: DomeApiClientMock };
});

// Mock the config module
vi.mock('./config', () => ({
  loadConfig: vi.fn(),
  isAuthenticated: vi.fn(),
}));

// Mock auth utils
vi.mock('./auth', () => ({
  ensureValidAccessToken: vi.fn(),
}));

describe('apiClient', () => {
  // Cast to a more general mock type, relying on Vitest's inference for the specifics.
  // This is often `MockInstance` or `SpyInstance` depending on the context.
  // Given `loadConfig` is a function, `vi.fn()` creates a mock function.
  const mockLoadConfig = configModule.loadConfig as unknown as ReturnType<typeof vi.fn>;
  const MockedDomeApiClient = DomeApiClient as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset mocks and clear the client instance before each test
    vi.clearAllMocks();
    clearApiClientInstance(); // Ensure a fresh state for apiClientInstance and lastUsedConfig
  });

  describe('getApiClient', () => {
    it('should throw when baseUrl is not configured', async () => {
      mockLoadConfig.mockReturnValue({} as any);
      await expect(getApiClient()).rejects.toThrow(
        'API base URL is not configured. Please run `dome config set --base-url <your_api_url>` or ensure DOME_ENV is set.',
      );
    });

    it('should create a new DomeApiClient instance with options from loadConfig', async () => {
      const config = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config);

      const client = await getApiClient();

      expect(mockLoadConfig).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenCalledWith({
        environment: config.baseUrl,
        token: config.apiKey,
      });
      expect(client).toBeInstanceOf(MockedDomeApiClient);
    });

    it('should reuse the client instance if config is unchanged', async () => {
      mockLoadConfig.mockReturnValue({ baseUrl: 'https://api.example.com', apiKey: 'secret-key' });
      (ensureValidAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        'refreshed-token-1',
      );

      const client1 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);

      // Call again with the same config
      const client2 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1); // Constructor not called again
      expect(mockLoadConfig).toHaveBeenCalledTimes(2); // loadConfig is called each time
      expect(client2).toBe(client1); // Should be the same instance
    });

    it('should create a new client if baseUrl changes', async () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config1.baseUrl,
        token: config1.apiKey,
      });

      const config2 = { baseUrl: 'https://api.new.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2); // Constructor called again
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config2.baseUrl,
        token: config2.apiKey,
      });
      expect(client2).not.toBe(client1);
    });

    it('should create a new client if apiKey changes', async () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key-1' };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config1.baseUrl,
        token: config1.apiKey,
      });

      const config2 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key-2' };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2); // Constructor called again
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config2.baseUrl,
        token: config2.apiKey,
      });
      expect(client2).not.toBe(client1);
    });

    it('should create a new instance if apiKey becomes undefined', async () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key-1' };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config1.baseUrl,
        token: config1.apiKey,
      });

      const config2 = { baseUrl: 'https://api.example.com', apiKey: undefined };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config2.baseUrl,
        token: config2.apiKey,
      });
      expect(client2).not.toBe(client1);
    });

    it('should create a new instance if apiKey was undefined and now has a value', async () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: undefined };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config1.baseUrl,
        token: config1.apiKey,
      });

      const config2 = { baseUrl: 'https://api.example.com', apiKey: 'new-key' };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({
        environment: config2.baseUrl,
        token: config2.apiKey,
      });
      expect(client2).not.toBe(client1);
    });
  });

  describe('clearApiClientInstance', () => {
    it('should set apiClientInstance and lastUsedConfig to null', async () => {
      const config = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config);

      // Create an instance first
      await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);

      clearApiClientInstance();

      // Call getApiClient again, it should create a new instance
      await getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2); // Constructor called again
    });
  });
});
