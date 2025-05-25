import { describe, it, expect } from 'vitest';
import { ServiceNameClient } from '../src/client';

describe('ServiceNameClient', () => {
  const client = new ServiceNameClient({
    baseUrl: 'https://api.example.com',
  });

  it('should be instantiated correctly', () => {
    expect(client).toBeInstanceOf(ServiceNameClient);
  });

  // Add more tests here
});