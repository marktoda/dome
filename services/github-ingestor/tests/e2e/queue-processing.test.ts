import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import { ulid } from 'ulid';
import { ExtendedMiniflare, asMiniflareWithCron } from '../types';

describe('GitHub Ingestor E2E Tests - Queue Processing', () => {
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
  
  it('should process file ingestion messages from the queue', async () => {
    // Mock GitHub API responses
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/git/blobs/')) {
        const content = Buffer.from('Test content for queue processing').toString('base64');
        return new Response(JSON.stringify({
          sha: 'file-sha',
          size: 150,
          content,
          encoding: 'base64',
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response('Not found', { status: 404 });
    });
    
    // Create a queue message for file ingestion
    const message = {
      type: 'ingest_file',
      repositoryId: 'test-repo-id',
      owner: 'test-owner',
      repo: 'test-repo',
      path: 'src/index.js',
      sha: 'file-sha',
      size: 150,
      mimeType: 'application/javascript',
    };
    
    // Send message to the queue
    await mf.dispatchQueue('INGEST_QUEUE', message);
    
    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify content blob was created
    const blob = await env.DB.prepare(
      'SELECT * FROM content_blobs WHERE sha = ?'
    ).bind('file-sha').first();
    
    expect(blob).not.toBeNull();
    expect(blob.size).toBe(150);
    expect(blob.mimeType).toBe('application/javascript');
    
    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
    
    // Verify the fetch call to GitHub API
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/git/blobs/file-sha'),
      expect.anything()
    );
  });
  
  it('should handle batch processing of multiple queue messages', async () => {
    // Mock GitHub API responses
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/git/blobs/')) {
        const sha = url.includes('file1-sha') ? 'file1-sha' : 'file2-sha';
        const content = Buffer.from(`Test content for ${sha}`).toString('base64');
        return new Response(JSON.stringify({
          sha,
          size: 150,
          content,
          encoding: 'base64',
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response('Not found', { status: 404 });
    });
    
    // Create multiple queue messages
    const messages = [
      {
        type: 'ingest_file',
        repositoryId: 'test-repo-id',
        owner: 'test-owner',
        repo: 'test-repo',
        path: 'src/file1.js',
        sha: 'file1-sha',
        size: 150,
        mimeType: 'application/javascript',
      },
      {
        type: 'ingest_file',
        repositoryId: 'test-repo-id',
        owner: 'test-owner',
        repo: 'test-repo',
        path: 'src/file2.js',
        sha: 'file2-sha',
        size: 150,
        mimeType: 'application/javascript',
      }
    ];
    
    // Send messages to the queue
    for (const message of messages) {
      await mf.dispatchQueue('INGEST_QUEUE', message);
    }
    
    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify content blobs were created
    const blobs = await env.DB.prepare('SELECT * FROM content_blobs').all();
    expect(blobs.results.length).toBe(2);
    
    // Verify Silo service was called twice
    expect(env.SILO.fetch).toHaveBeenCalledTimes(2);
  });
  
  it('should handle errors during queue processing and retry', async () => {
    // Mock GitHub API to fail on first call, succeed on second
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/git/blobs/')) {
        callCount++;
        if (callCount === 1) {
          // First call fails
          return new Response(JSON.stringify({
            message: 'Server error',
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        } else {
          // Second call succeeds
          const content = Buffer.from('Test content after retry').toString('base64');
          return new Response(JSON.stringify({
            sha: 'retry-file-sha',
            size: 150,
            content,
            encoding: 'base64',
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      
      return new Response('Not found', { status: 404 });
    });
    
    // Create a queue message
    const message = {
      type: 'ingest_file',
      repositoryId: 'test-repo-id',
      owner: 'test-owner',
      repo: 'test-repo',
      path: 'src/retry-file.js',
      sha: 'retry-file-sha',
      size: 150,
      mimeType: 'application/javascript',
    };
    
    // Send message to the queue
    await mf.dispatchQueue('INGEST_QUEUE', message);
    
    // Wait for first attempt and retry
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify content blob was created after retry
    const blob = await env.DB.prepare(
      'SELECT * FROM content_blobs WHERE sha = ?'
    ).bind('retry-file-sha').first();
    
    // This might fail if the retry mechanism isn't properly implemented in the actual code
    // In a real implementation, you would need to ensure the retry logic works as expected
    expect(blob).not.toBeNull();
    expect(blob.size).toBe(150);
    
    // Verify GitHub API was called twice (initial + retry)
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});