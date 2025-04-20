import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { ExtendedMiniflare } from '../types';
import { createTestMiniflare } from './helpers';

describe('GitHub Ingestor E2E Tests - Ingestion Flow', () => {
  let mf: ExtendedMiniflare;
  let env: any;
  
  beforeAll(async () => {
    // Set up Miniflare environment
    mf = createTestMiniflare({});
    
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
    
    // Set up test data
    await env.DB.exec(`
      INSERT INTO provider_repositories (
        id, userId, provider, owner, repo, branch, isPrivate, createdAt, updatedAt
      ) VALUES (
        'test-repo-id', 'test-user-id', 'github', 'test-owner', 'test-repo', 'main', 0, 
        ${Math.floor(Date.now() / 1000)}, ${Math.floor(Date.now() / 1000)}
      )
    `);
  });
  
  afterEach(async () => {
    // Clean up test data
    await env.DB.exec('DELETE FROM provider_repositories');
    await env.DB.exec('DELETE FROM content_blobs');
  });
  
  it('should process a repository through the complete ingestion flow', async () => {
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
            {
              path: 'src/index.js',
              mode: '100644',
              type: 'blob',
              sha: 'index-sha',
              size: 200,
              url: 'https://api.github.com/repos/test-owner/test-repo/git/blobs/index-sha',
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
          sha: url.includes('readme-sha') ? 'readme-sha' : 'index-sha',
          size: url.includes('readme-sha') ? 100 : 200,
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
    ).bind('test-repo-id').first();
    
    expect(repo).not.toBeNull();
    expect(repo.lastSyncedAt).not.toBeNull();
    
    // Verify content blobs were created
    const blobs = await env.DB.prepare('SELECT * FROM content_blobs').all();
    expect(blobs.results.length).toBeGreaterThan(0);
    
    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
  });
});