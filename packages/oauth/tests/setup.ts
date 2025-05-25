import { beforeEach } from 'vitest';

beforeEach(() => {
  // Clear environment variables for clean test state
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.GITHUB_SCOPES;
  delete process.env.NOTION_CLIENT_ID;
  delete process.env.NOTION_CLIENT_SECRET;
});