import { describe, it, expect, vi, beforeEach } from 'vitest';
import { {{SERVICE_NAME}}Client } from '../src/client';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

describe('{{SERVICE_NAME}}Client', () => {
  let client: {{SERVICE_NAME}}Client;

  beforeEach(() => {
    client = new {{SERVICE_NAME}}Client({
      baseUrl: 'http://localhost:8787',
      apiKey: 'test-key',
    });
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create client instance', () => {
      expect(client).toBeInstanceOf({{SERVICE_NAME}}Client);
    });

    it('should handle base URL with trailing slash', () => {
      const clientWithSlash = new {{SERVICE_NAME}}Client({
        baseUrl: 'http://localhost:8787/',
      });
      expect(clientWithSlash).toBeInstanceOf({{SERVICE_NAME}}Client);
    });
  });

  describe('healthCheck', () => {
    it('should perform health check', async () => {
      const mockResponse = {
        status: 'healthy',
        service: '{{SERVICE_NAME}}',
        timestamp: new Date().toISOString(),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await client.healthCheck();
      
      expect(result).toMatchObject(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8787/health');
    });

    it('should handle health check failures', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(client.healthCheck()).rejects.toThrow();
    });
  });

  describe('example method', () => {
    it('should call example endpoint successfully', async () => {
      const mockResponse = {
        message: 'Hello from {{SERVICE_NAME}} service',
        timestamp: new Date().toISOString(),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await client.example();
      
      expect(result).toMatchObject(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/{{SERVICE_NAME}}',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-key',
          }),
        })
      );
    });

    it('should handle API errors', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValueOnce({ error: 'Bad Request' }),
      });

      await expect(client.example()).rejects.toThrow();
    });

    it('should work without API key', async () => {
      const clientWithoutKey = new {{SERVICE_NAME}}Client({
        baseUrl: 'http://localhost:8787',
      });

      const mockResponse = {
        message: 'Hello from {{SERVICE_NAME}} service',
        timestamp: new Date().toISOString(),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await clientWithoutKey.example();
      
      expect(result).toMatchObject(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/{{SERVICE_NAME}}',
        expect.objectContaining({
          headers: expect.not.objectContaining({
            'Authorization': expect.any(String),
          }),
        })
      );
    });
  });
});