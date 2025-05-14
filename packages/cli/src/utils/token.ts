import * as jose from 'jose';

export function isExpired(token: string, leewaySeconds = 30): boolean {
  try {
    const { exp } = jose.decodeJwt(token) as { exp?: number };
    if (!exp) return true;
    return exp * 1000 < Date.now() + leewaySeconds * 1000;
  } catch {
    return true;
  }
} 