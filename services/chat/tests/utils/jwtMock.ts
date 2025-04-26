// Mock JWT functions to replace @tsndr/cloudflare-worker-jwt
export async function verify(token: string, secret: string, options?: any): Promise<boolean> {
  // This is a mock implementation that always returns true
  return true;
}

export function decode(token: string): { header: any; payload: any } {
  // This is a mock implementation that returns a basic decoded structure
  return {
    header: { alg: 'HS256', typ: 'JWT' },
    payload: {
      sub: 'user123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}
