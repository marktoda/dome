import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import * as crypto from 'crypto';
import { ExtendedMiniflare } from '../types';
import { createTestMiniflare } from './helpers';

describe('GitHub Ingestor E2E Tests - Webhook Handling', () => {
  let mf: ExtendedMiniflare;
  let env: any;
  const webhookSecret = 'test-webhook-secret';

  beforeAll(async () => {
    // Set up Miniflare environment
    mf = createTestMiniflare({
      bindings: {
        GITHUB_WEBHOOK_SECRET: webhookSecret,
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

  // Helper function to create a signed webhook payload
  function createSignedWebhook(payload: any): { signature: string; body: string } {
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

    return {
      signature: `sha256=${signature}`,
      body,
    };
  }

  it('should process a push webhook event', async () => {
    // Mock GitHub API responses for blob content
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/git/blobs/')) {
        const content = Buffer.from('Updated content').toString('base64');
        return new Response(
          JSON.stringify({
            sha: 'new-file-sha',
            size: 150,
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
    const { signature, body } = createSignedWebhook(pushPayload);

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

    // Verify repository was updated
    const repo = await env.DB.prepare('SELECT * FROM provider_repositories WHERE id = ?')
      .bind('test-repo-id')
      .first();

    expect(repo).not.toBeNull();
    expect(repo.lastCommitSha).toBe('new-commit-sha');

    // Verify Silo service was called
    expect(env.SILO.fetch).toHaveBeenCalled();
  });

  it('should reject webhook with invalid signature', async () => {
    // Create a push webhook payload
    const pushPayload = {
      ref: 'refs/heads/main',
      repository: {
        id: 12345,
        name: 'test-repo',
        owner: {
          login: 'test-owner',
        },
      },
    };

    // Use invalid signature
    const invalidSignature = 'sha256=invalid-signature';
    const body = JSON.stringify(pushPayload);

    // Send webhook request
    const res = await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': invalidSignature,
      },
      body,
    });

    // Verify response
    expect(res.status).toBe(401);

    // Verify Silo service was not called
    expect(env.SILO.fetch).not.toHaveBeenCalled();
  });

  it('should handle installation webhook event', async () => {
    // Create an installation webhook payload
    const installationPayload = {
      action: 'created',
      installation: {
        id: 'test-installation-id',
        account: {
          login: 'test-owner',
        },
      },
      repositories: [
        {
          id: 12345,
          name: 'test-repo',
          private: false,
        },
      ],
    };

    // Sign the webhook payload
    const { signature, body } = createSignedWebhook(installationPayload);

    // Send webhook request
    const res = await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': signature,
      },
      body,
    });

    // Verify response
    expect(res.status).toBe(200);

    // Verify credentials were stored
    const credentials = await env.DB.prepare(
      'SELECT * FROM provider_credentials WHERE provider = ? AND installationId = ?',
    )
      .bind('github', 'test-installation-id')
      .first();

    expect(credentials).not.toBeNull();
  });
});
