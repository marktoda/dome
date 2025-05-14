import { loadConfig, saveApiKey, saveConfig } from './config';
import { getApiBaseUrl } from './apiClient';
import * as jose from 'jose';

interface RefreshResponse { token: string; refreshToken: string; expiresAt: number; }

export async function ensureValidAccessToken(): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('Not logged in. Please run `dome login`.');

  let expSeconds: number | undefined = cfg.accessTokenExpiresAt;
  if (!expSeconds) {
    try {
      const payload = jose.decodeJwt(cfg.apiKey) as { exp?: number };
      if (payload.exp) {
        expSeconds = payload.exp;
        // cache for next time
        saveConfig({ accessTokenExpiresAt: expSeconds } as any);
      }
    } catch {
      // ignore decode errors
    }
  }

  if (expSeconds && expSeconds * 1000 > Date.now() + 30 * 1000) {
    return cfg.apiKey; // still valid (more than 30s left)
  }

  // Token is about to expire or unknown expiry; attempt refresh if we have a refresh token
  if (!cfg.refreshToken) {
    if (expSeconds && expSeconds * 1000 > Date.now()) {
      // still technically valid but within 30s window and cannot refresh; just return
      return cfg.apiKey;
    }
    throw new Error('Session expired. Please login again.');
  }

  const baseUrl = getApiBaseUrl();
  const res = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: cfg.refreshToken }),
  });
  if (!res.ok) throw new Error('Unable to refresh session, please login again.');
  const data: RefreshResponse = await res.json();

  saveApiKey(data.token);
  saveConfig({ refreshToken: data.refreshToken, accessTokenExpiresAt: data.expiresAt } as any);
  return data.token;
} 