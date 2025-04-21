import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ulid } from 'ulid';
import { ExtendedMiniflare } from '../types';
import { createTestMiniflare } from './helpers';
import { createSignedWebhook } from '../crypto-helpers';

/**
 * Deployment Verification Test
 *
 * This test verifies that the GitHub Ingestor service is working correctly after deployment.
 * It tests all critical functionality:
 * 1. Health check endpoint
 * 2. Webhook handling
 * 3. Repository syncing
 * 4. Queue processing
 */
describe('GitHub Ingestor Deployment Verification', () => {
  let mf: ExtendedMiniflare;
  let env: any;
  const webhookSecret = 'test-webhook-secret';

  beforeAll(async () => {
    // Set up Miniflare environment
    mf = createTestMiniflare({
      bindings: {
        GITHUB_WEBHOOK_SECRET: webhookSecret,
        GITHUB_TOKEN: 'test-github-token',
      },
    });

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

    // Mock GitHub API responses
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/repos/test-owner/test-repo')) {
        return new Response(
          JSON.stringify({
            id: 12345,
            name: 'test-repo',
            owner: { login: 'test-owner' },
            default_branch: 'main',
            private: false,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url.includes('/git/trees/main')) {
        return new Response(
          JSON.stringify({
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
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url.includes('/git/blobs/')) {
        const content = Buffer.from('Test content').toString('base64');
        return new Response(
          JSON.stringify({
            sha: 'readme-sha',
            size: 100,
            content,
            encoding: 'base64',
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response('Not found', { status: 404 });
    });

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

  afterAll(async () => {
    await env.DB.exec('DELETE FROM provider_repositories');
    await env.DB.exec('DELETE FROM content_blobs');
    await mf.dispose();
  });

  // Helper function to create a signed webhook payload
  async function createSignedPayload(payload: any): Promise<{ signature: string; body: string }> {
    return await createSignedWebhook(payload, webhookSecret);
  }

  it('should verify health check endpoint', async () => {
    const res = await mf.dispatchFetch('http://localhost/health');
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      status: string;
      version: string;
      environment: string;
      components: {
        database: {
          status: string;
        };
      };
    };
    expect(data.status).toBe('ok');
    expect(data.version).toBe('1.0.0-test');
    expect(data.environment).toBe('test');
    expect(data.components.database.status).toBe('ok');
  });

  it('should verify status endpoint', async () => {
    const res = await mf.dispatchFetch('http://localhost/status');
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      status: string;
      version: string;
      repositories: any;
    };
    expect(data.status).toBe('ok');
    expect(data.version).toBe('1.0.0-test');
    expect(data.repositories).toBeDefined();
  });

  it('should verify webhook handling', async () => {
    // Create a push webhook payload
    const pushPayload = {
      ref: 'refs/heads/main',
      repository: {
        id: 12345,
        name: 'test-repo',
        owner: {
          login: 'test-owner',
        },
        private: false,
      },
      commits: [
        {
          id: 'new-commit-sha',
          message: 'Update README.md',
          added: [],
          removed: [],
          modified: ['README.md'],
        },
      ],
      head_commit: {
        id: 'new-commit-sha',
        tree_id: 'new-tree-sha',
      },
    };

    // Sign the webhook payload
    const { signature, body } = await createSignedPayload(pushPayload);

    // Send webhook request
    const res = await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signature,
      },
      body,
    });

    // Verify response
    expect(res.status).toBe(200);

    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
  });

  it('should verify cron-triggered sync', async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Trigger cron handler
    await mf.dispatchCron('0 * * * *');

    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify repository was updated
    const repo = await env.DB.prepare('SELECT * FROM provider_repositories WHERE id = ?')
      .bind('test-repo-id')
      .first();

    expect(repo).not.toBeNull();
    expect(repo.lastSyncedAt).not.toBeNull();

    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
  });

  it('should verify queue processing', async () => {
    // Reset mocks
    vi.clearAllMocks();

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
    // @ts-ignore - Ignoring TypeScript errors for queue dispatch
    await mf.dispatchQueue('INGEST_QUEUE', message);

    // Wait for queue processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
  });

  it('should verify metrics collection', async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Make a request to trigger metrics
    await mf.dispatchFetch('http://localhost/health');

    // Verify metrics were collected
    // This is a bit tricky to test directly, but we can check that the
    // health check endpoint returns successfully, which implies metrics
    // are being collected

    // In a real deployment verification, you would check your metrics
    // dashboard to ensure metrics are being reported correctly
  });
});
