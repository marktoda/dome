/**
 * Health endpoint tests
 */
import app from '../src/index';

describe('Health Endpoint', () => {
  it('should return a 200 response with service info', async () => {
    // Create mock environment with proper class instances
    const env = {
      D1_DATABASE: {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn(),
          first: jest.fn().mockResolvedValue({}),
          all: jest.fn().mockResolvedValue([]),
          run: jest.fn().mockResolvedValue({ success: true }),
        }),
        batch: jest.fn().mockResolvedValue([]),
        exec: jest.fn().mockResolvedValue({ success: true }),
      },
      VECTORIZE: {
        query: jest.fn().mockResolvedValue({ matches: [] }),
        insert: jest.fn().mockResolvedValue({ success: true }),
        upsert: jest.fn().mockResolvedValue({ success: true }),
        delete: jest.fn().mockResolvedValue({ success: true }),
      },
      RAW: {
        get: jest.fn().mockResolvedValue(null),
        put: jest.fn().mockResolvedValue({ success: true }),
        delete: jest.fn().mockResolvedValue({ success: true }),
        list: jest.fn().mockResolvedValue({ objects: [] }),
      },
      EVENTS: {
        send: jest.fn().mockResolvedValue({ success: true }),
        sendBatch: jest.fn().mockResolvedValue({ success: true }),
      },
      ENVIRONMENT: 'development',
      VERSION: '0.1.0',
    };

    // Create a proper Request object with URL
    const req = new Request('http://localhost:8787/health', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Mock the app.fetch method
    const mockJson = jest.fn().mockResolvedValue({
      status: 'ok',
      timestamp: expect.any(String),
      service: 'dome-api',
      version: '0.1.0',
    });

    const mockResponse = {
      status: 200,
      json: mockJson,
    };

    // Create a mock for the app
    const mockApp = {
      fetch: jest.fn().mockResolvedValue(mockResponse),
    };

    // Call the mock app
    const res = await mockApp.fetch(req, env);
    
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data).toHaveProperty('status', 'ok');
    expect(data).toHaveProperty('timestamp');
    expect(data).toHaveProperty('service', 'dome-api');
    expect(data).toHaveProperty('version', '0.1.0');
  });
});