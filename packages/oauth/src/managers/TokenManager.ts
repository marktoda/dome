import { StandardTokenData } from '../types.js';

export interface TokenStorage {
  storeToken(tokenData: StandardTokenData): Promise<string>;
  getToken(userId: string, provider: string, providerAccountId?: string): Promise<StandardTokenData | null>;
  updateToken(tokenData: StandardTokenData): Promise<void>;
  revokeToken(userId: string, provider: string, providerAccountId?: string): Promise<void>;
  listTokens(userId: string, provider?: string): Promise<StandardTokenData[]>;
}

export interface TokenEncryption {
  encrypt(data: string): Promise<string>;
  decrypt(encryptedData: string): Promise<string>;
}

export class NoOpTokenEncryption implements TokenEncryption {
  async encrypt(data: string): Promise<string> {
    return data;
  }

  async decrypt(encryptedData: string): Promise<string> {
    return encryptedData;
  }
}

export class MemoryTokenStorage implements TokenStorage {
  private tokens = new Map<string, StandardTokenData>();

  private getKey(userId: string, provider: string, providerAccountId?: string): string {
    return providerAccountId 
      ? `${userId}:${provider}:${providerAccountId}`
      : `${userId}:${provider}`;
  }

  async storeToken(tokenData: StandardTokenData): Promise<string> {
    const key = this.getKey(tokenData.userId, tokenData.provider, tokenData.providerAccountId);
    this.tokens.set(key, { ...tokenData });
    return key;
  }

  async getToken(userId: string, provider: string, providerAccountId?: string): Promise<StandardTokenData | null> {
    const key = this.getKey(userId, provider, providerAccountId);
    const token = this.tokens.get(key);
    return token ? { ...token } : null;
  }

  async updateToken(tokenData: StandardTokenData): Promise<void> {
    await this.storeToken(tokenData);
  }

  async revokeToken(userId: string, provider: string, providerAccountId?: string): Promise<void> {
    const key = this.getKey(userId, provider, providerAccountId);
    this.tokens.delete(key);
  }

  async listTokens(userId: string, provider?: string): Promise<StandardTokenData[]> {
    const tokens: StandardTokenData[] = [];
    
    for (const [key, token] of this.tokens) {
      if (key.startsWith(`${userId}:`)) {
        if (!provider || token.provider === provider) {
          tokens.push({ ...token });
        }
      }
    }
    
    return tokens;
  }
}

export class TokenManager {
  private static instance: TokenManager;
  private storage: TokenStorage;
  private encryption: TokenEncryption;

  constructor(
    storage: TokenStorage = new MemoryTokenStorage(),
    encryption: TokenEncryption = new NoOpTokenEncryption()
  ) {
    this.storage = storage;
    this.encryption = encryption;
  }

  static getInstance(storage?: TokenStorage, encryption?: TokenEncryption): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager(storage, encryption);
    }
    return TokenManager.instance;
  }

  async storeToken(tokenData: StandardTokenData): Promise<string> {
    // Encrypt sensitive data
    const encryptedTokenData: StandardTokenData = {
      ...tokenData,
      accessToken: await this.encryption.encrypt(tokenData.accessToken),
      refreshToken: tokenData.refreshToken 
        ? await this.encryption.encrypt(tokenData.refreshToken)
        : undefined,
    };

    return await this.storage.storeToken(encryptedTokenData);
  }

  async getToken(userId: string, provider: string, providerAccountId?: string): Promise<StandardTokenData | null> {
    const tokenData = await this.storage.getToken(userId, provider, providerAccountId);
    
    if (!tokenData) {
      return null;
    }

    // Decrypt sensitive data
    return {
      ...tokenData,
      accessToken: await this.encryption.decrypt(tokenData.accessToken),
      refreshToken: tokenData.refreshToken 
        ? await this.encryption.decrypt(tokenData.refreshToken)
        : undefined,
    };
  }

  async updateToken(tokenData: StandardTokenData): Promise<void> {
    // Encrypt sensitive data before storing
    const encryptedTokenData: StandardTokenData = {
      ...tokenData,
      accessToken: await this.encryption.encrypt(tokenData.accessToken),
      refreshToken: tokenData.refreshToken 
        ? await this.encryption.encrypt(tokenData.refreshToken)
        : undefined,
    };

    await this.storage.updateToken(encryptedTokenData);
  }

  async revokeToken(userId: string, provider: string, providerAccountId?: string): Promise<void> {
    await this.storage.revokeToken(userId, provider, providerAccountId);
  }

  async refreshToken(tokenData: StandardTokenData): Promise<StandardTokenData | null> {
    // This would implement token refresh logic specific to each provider
    // For now, we'll return null to indicate refresh is not supported
    return null;
  }

  async isTokenExpired(tokenData: StandardTokenData): boolean {
    if (!tokenData.expiresAt) {
      return false;
    }

    return Date.now() >= tokenData.expiresAt.getTime();
  }

  async getValidToken(userId: string, provider: string, providerAccountId?: string): Promise<StandardTokenData | null> {
    const tokenData = await this.getToken(userId, provider, providerAccountId);
    
    if (!tokenData) {
      return null;
    }

    if (await this.isTokenExpired(tokenData)) {
      if (tokenData.refreshToken) {
        const refreshedToken = await this.refreshToken(tokenData);
        if (refreshedToken) {
          await this.updateToken(refreshedToken);
          return refreshedToken;
        }
      }
      // Token is expired and cannot be refreshed
      await this.revokeToken(userId, provider, providerAccountId);
      return null;
    }

    return tokenData;
  }
}