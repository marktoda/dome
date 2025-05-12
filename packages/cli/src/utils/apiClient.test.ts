import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getApiClient, clearApiClientInstance } from './apiClient';
import * as configModule from './config';
import { DomeApiClient } from '@dome/dome-sdk';

// Mock the DomeApiClient constructor
vi.mock('@dome/dome-sdk', () => {
  const DomeApiClientMock = vi.fn();
  DomeApiClientMock.prototype.someMethod = vi.fn(); // Example method if needed for deeper testing
  return { DomeApiClient: DomeApiClientMock };
});

// Mock the config module
vi.mock('./config', () => ({
  loadConfig: vi.fn(),
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
    it('should throw an error if baseUrl is not configured', () => {
      mockLoadConfig.mockReturnValue({ baseUrl: undefined, apiKey: 'test-key' });
      expect(() => getApiClient()).toThrow(
        'API base URL is not configured. Please run `dome config set --base-url <your_api_url>` or ensure DOME_ENV is set.',
      );
    });

    it('should create a new DomeApiClient instance with options from loadConfig', () => {
      const config = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config);

      const client = getApiClient();

      expect(mockLoadConfig).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenCalledWith({
        environment: config.baseUrl,
        token: config.apiKey,
      });
      expect(client).toBeInstanceOf(MockedDomeApiClient);
    });

    it('should return a cached instance if config has not changed', () => {
      const config = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config);

      const client1 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);

      // Call again with the same config
      const client2 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1); // Constructor not called again
      expect(mockLoadConfig).toHaveBeenCalledTimes(2); // loadConfig is called each time
      expect(client2).toBe(client1); // Should be the same instance
    });

    it('should create a new instance if baseUrl changes', () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config1.baseUrl, token: config1.apiKey });


      const config2 = { baseUrl: 'https://api.new.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2); // Constructor called again
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config2.baseUrl, token: config2.apiKey });
      expect(client2).not.toBe(client1);
    });

    it('should create a new instance if apiKey changes', () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key-1' };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config1.baseUrl, token: config1.apiKey });

      const config2 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key-2' };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2); // Constructor called again
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config2.baseUrl, token: config2.apiKey });
      expect(client2).not.toBe(client1);
    });

     it('should create a new instance if apiKey becomes undefined', () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: 'secret-key-1' };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config1.baseUrl, token: config1.apiKey });

      const config2 = { baseUrl: 'https://api.example.com', apiKey: undefined };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config2.baseUrl, token: config2.apiKey });
      expect(client2).not.toBe(client1);
    });

    it('should create a new instance if apiKey was undefined and now has a value', () => {
      const config1 = { baseUrl: 'https://api.example.com', apiKey: undefined };
      mockLoadConfig.mockReturnValue(config1);
      const client1 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config1.baseUrl, token: config1.apiKey });

      const config2 = { baseUrl: 'https://api.example.com', apiKey: 'new-key' };
      mockLoadConfig.mockReturnValue(config2);
      const client2 = getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2);
      expect(MockedDomeApiClient).toHaveBeenLastCalledWith({ environment: config2.baseUrl, token: config2.apiKey });
      expect(client2).not.toBe(client1);
    });
  });

  describe('clearApiClientInstance', () => {
    it('should set apiClientInstance and lastUsedConfig to null', () => {
      const config = { baseUrl: 'https://api.example.com', apiKey: 'secret-key' };
      mockLoadConfig.mockReturnValue(config);

      // Create an instance first
      getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(1);

      clearApiClientInstance();

      // Call getApiClient again, it should create a new instance
      getApiClient();
      expect(MockedDomeApiClient).toHaveBeenCalledTimes(2); // Constructor called again
    });
  });
});