/**
 * Health endpoint tests
 */
import app from '../src/index';

describe('Health Endpoint', () => {
  it('should return a 200 response with service info', async () => {
    const env = {
      D1_DATABASE: new D1Database(),
      VECTORIZE: new VectorizeIndex(),
      RAW: new R2Bucket(),
      EVENTS: new Queue(),
    };

    const req = new Request('http://localhost/health');
    const res = await app.fetch(req, env);
    
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data).toHaveProperty('status', 'ok');
    expect(data).toHaveProperty('timestamp');
    expect(data).toHaveProperty('service', 'dome-api');
    expect(data).toHaveProperty('version', '0.1.0');
  });
});