import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import { ulid } from 'ulid';
import { ExtendedMiniflare, MiniflareOptions, asMiniflareWithCron } from '../types';

describe('GitHub Ingestor E2E Tests - Cron Sync', () => {
  let mf: ExtendedMiniflare;
  let env: any;
  
  beforeAll(async () => {
    // Set up Miniflare environment
    mf = asMiniflareWithCron(new Miniflare({
      modules: true,
      scriptPath: 'dist/index.js',
      bindings: {
        VERSION: '1.0.0-test',
        ENVIRONMENT: 'test',
        LOG_LEVEL: 'debug',
        GITHUB_TOKEN: 'test-github-token',
      },
      d1Databases: [
        {
          binding: 'DB',
          database: ':memory:',
          migrationsPath: 'src/db/migrations',
        },
      ],
      queueConsumers: ['INGEST_QUEUE'],
      serviceBindings: {
        SILO: {
          fetch: vi.fn(),
        },
      },
    } as any));
    
    env = await mf.getBindings();
    
    // Mock Silo service
    env.SILO.fetch.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      
      if (url.pathname.startsWith('/store')) {
        return new Response(JSON.stringify({ success: true, id: ulid() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response('Not found', { status: 404 });
    });
  });
  
  afterAll(async () => {
    await mf.dispose();
  });
  
  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();
  });
  
  afterEach(async () => {
    // Clean up test data
    await env.DB.exec('DELETE FROM provider_repositories');
    await env.DB.exec('DELETE FROM content_blobs');
  });
  
  it('should sync repositories that have never been synced', async () => {
    // Insert a repository that has never been synced
    await env.DB.exec(`
      INSERT INTO provider_repositories (
        id, userId, provider, owner, repo, branch, isPrivate, createdAt, updatedAt
      ) VALUES (
        'never-synced-repo', 'test-user-id', 'github', 'test-owner', 'test-repo', 'main', 0, 
        ${Math.floor(Date.now() / 1000)}, ${Math.floor(Date.now() / 1000)}
      )
    `);
    
    // Mock GitHub API responses
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/repos/test-owner/test-repo')) {
        return new Response(JSON.stringify({
          id: 12345,
          name: 'test-repo',
          owner: { login: 'test-owner' },
          default_branch: 'main',
          private: false,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (url.includes('/git/trees/main')) {
        return new Response(JSON.stringify({
          sha: 'tree-sha',
          tree: [
            {
              path: 'README.md',
              mode: '100644',
              type: 'blob',
              sha: 'readme-sha',
              size: 100,
              url: 'https://api.github.com/repos/test-owner/test-repo/git/blobs/readme-sha',
            },
          ],
          truncated: false,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (url.includes('/git/blobs/')) {
        const content = Buffer.from('Test content').toString('base64');
        return new Response(JSON.stringify({
          sha: 'readme-sha',
          size: 100,
          content,
          encoding: 'base64',
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response('Not found', { status: 404 });
    });
    
    // Trigger cron handler
    const res = await mf.dispatchCron('0 * * * *');
    expect(res).toBeUndefined();
    
    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify repository was updated
    const repo = await env.DB.prepare(
      'SELECT * FROM provider_repositories WHERE id = ?'
    ).bind('never-synced-repo').first();
    
    expect(repo).not.toBeNull();
    expect(repo.lastSyncedAt).not.toBeNull();
    expect(repo.lastCommitSha).not.toBeNull();
    
    // Verify content blobs were created
    const blobs = await env.DB.prepare('SELECT * FROM content_blobs').all();
    expect(blobs.results.length).toBeGreaterThan(0);
    
    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
  });
  
  it('should sync repositories with conditional requests using ETags', async () => {
    // Insert a repository that has been synced before with an ETag
    const lastSyncedAt = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    await env.DB.exec(`
      INSERT INTO provider_repositories (
        id, userId, provider, owner, repo, branch, lastSyncedAt, lastCommitSha, etag, isPrivate, createdAt, updatedAt
      ) VALUES (
        'etag-repo', 'test-user-id', 'github', 'test-owner', 'test-repo', 'main', 
        ${lastSyncedAt}, 'old-commit-sha', 'W/"test-etag"', 0, 
        ${Math.floor(Date.now() / 1000)}, ${Math.floor(Date.now() / 1000)}
      )
    `);
    
    // Mock GitHub API responses with ETag handling
    global.fetch = vi.fn().mockImplementation(async (url: string, options: any) => {
      // Check if request has If-None-Match header with our ETag
      if (options?.headers?.['If-None-Match'] === 'W/"test-etag"') {
        // Return 304 Not Modified
        return new Response(null, { status: 304 });
      }
      
      // Otherwise return normal responses
      if (url.includes('/repos/test-owner/test-repo')) {
        return new Response(JSON.stringify({
          id: 12345,
          name: 'test-repo',
          owner: { login: 'test-owner' },
          default_branch: 'main',
          private: false,
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'ETag': 'W/"new-etag"'
          },
        });
      }
      
      return new Response('Not found', { status: 404 });
    });
    
    // Trigger cron handler
    const res = await mf.dispatchCron('0 * * * *');
    expect(res).toBeUndefined();
    
    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify repository was updated with new sync time but same commit SHA
    const repo = await env.DB.prepare(
      'SELECT * FROM provider_repositories WHERE id = ?'
    ).bind('etag-repo').first();
    
    expect(repo).not.toBeNull();
    expect(repo.lastSyncedAt).toBeGreaterThan(lastSyncedAt);
    expect(repo.lastCommitSha).toBe('old-commit-sha'); // Should not change
    expect(repo.etag).toBe('W/"test-etag"'); // Should not change since we got 304
    
    // Verify Silo service was not called (no changes)
    expect(env.SILO.fetch).not.toHaveBeenCalled();
  });
  
  it('should handle rate limit errors and set nextRetryAt', async () => {
    // Insert a repository
    await env.DB.exec(`
      INSERT INTO provider_repositories (
        id, userId, provider, owner, repo, branch, isPrivate, createdAt, updatedAt
      ) VALUES (
        'rate-limited-repo', 'test-user-id', 'github', 'test-owner', 'test-repo', 'main', 0, 
        ${Math.floor(Date.now() / 1000)}, ${Math.floor(Date.now() / 1000)}
      )
    `);
    
    // Mock GitHub API responses with rate limit error
    const rateLimitReset = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        message: 'API rate limit exceeded',
        documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': '5000',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateLimitReset.toString(),
        },
      });
    });
    
    // Trigger cron handler
    const res = await mf.dispatchCron('0 * * * *');
    expect(res).toBeUndefined();
    
    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify repository was updated with rate limit info
    const repo = await env.DB.prepare(
      'SELECT * FROM provider_repositories WHERE id = ?'
    ).bind('rate-limited-repo').first();
    
    expect(repo).not.toBeNull();
    expect(repo.rateLimitReset).toBe(rateLimitReset);
    expect(repo.nextRetryAt).toBeGreaterThanOrEqual(rateLimitReset);
    expect(repo.retryCount).toBe(1);
    
    // Verify Silo service was not called
    expect(env.SILO.fetch).not.toHaveBeenCalled();
  });
});