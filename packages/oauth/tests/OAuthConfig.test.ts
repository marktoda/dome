import { describe, it, expect, beforeEach } from 'vitest';
import { OAuthConfig } from '../src/config.js';
import { OAuthProvider } from '../src/types.js';

describe('OAuthConfig', () => {
  beforeEach(() => {
    // Clear any existing configs
    OAuthConfig['configs'].clear();
  });

  it('should set and get provider configuration', () => {
    const config = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      authUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read', 'write'],
    };

    OAuthConfig.setConfig('test-provider', config);
    const retrievedConfig = OAuthConfig.getConfig('test-provider');

    expect(retrievedConfig).toEqual(config);
  });

  it('should throw error for missing provider configuration', () => {
    expect(() => {
      OAuthConfig.getConfig('non-existent-provider');
    }).toThrow('OAuth configuration not found for provider: non-existent-provider');
  });

  it('should validate configuration schema', () => {
    expect(() => {
      OAuthConfig.setConfig('invalid-provider', {
        clientId: '',
        clientSecret: 'secret',
        authUrl: 'invalid-url',
        tokenUrl: 'https://example.com/token',
      } as any);
    }).toThrow();
  });

  it('should initialize GitHub configuration from environment', () => {
    process.env.GITHUB_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'github-client-secret';
    process.env.GITHUB_SCOPES = 'user:email,read:org';

    OAuthConfig.initializeFromEnv();

    expect(OAuthConfig.hasConfig(OAuthProvider.GITHUB)).toBe(true);
    
    const githubConfig = OAuthConfig.getConfig(OAuthProvider.GITHUB);
    expect(githubConfig.clientId).toBe('github-client-id');
    expect(githubConfig.clientSecret).toBe('github-client-secret');
    expect(githubConfig.scopes).toEqual(['user:email', 'read:org']);
  });

  it('should initialize Notion configuration from environment', () => {
    process.env.NOTION_CLIENT_ID = 'notion-client-id';
    process.env.NOTION_CLIENT_SECRET = 'notion-client-secret';

    OAuthConfig.initializeFromEnv();

    expect(OAuthConfig.hasConfig(OAuthProvider.NOTION)).toBe(true);
    
    const notionConfig = OAuthConfig.getConfig(OAuthProvider.NOTION);
    expect(notionConfig.clientId).toBe('notion-client-id');
    expect(notionConfig.clientSecret).toBe('notion-client-secret');
  });

  it('should validate environment variables', () => {
    const missingVars = OAuthConfig.validateEnvironment();
    expect(missingVars).toContain('GITHUB_CLIENT_ID');
    expect(missingVars).toContain('GITHUB_CLIENT_SECRET');
    expect(missingVars).toContain('NOTION_CLIENT_ID');
    expect(missingVars).toContain('NOTION_CLIENT_SECRET');

    process.env.GITHUB_CLIENT_ID = 'test';
    process.env.GITHUB_CLIENT_SECRET = 'test';

    const missingVarsAfter = OAuthConfig.validateEnvironment();
    expect(missingVarsAfter).not.toContain('GITHUB_CLIENT_ID');
    expect(missingVarsAfter).not.toContain('GITHUB_CLIENT_SECRET');
    expect(missingVarsAfter).toContain('NOTION_CLIENT_ID');
    expect(missingVarsAfter).toContain('NOTION_CLIENT_SECRET');
  });
});