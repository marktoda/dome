import { beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let testVaultPath: string;

beforeAll(async () => {
  // Create a temporary directory for test vault
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dome-test-'));
  testVaultPath = path.join(tmpDir, 'vault');
  await fs.mkdir(testVaultPath, { recursive: true });
  
  // Set the test vault path in environment
  process.env.DOME_VAULT_PATH = testVaultPath;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce noise during tests
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-for-tests';
  process.env.POSTGRES_URI = process.env.POSTGRES_URI || 'postgresql://test:test@localhost:5432/test';
});

beforeEach(async () => {
  // Clean the test vault before each test
  if (testVaultPath) {
    try {
      const files = await fs.readdir(testVaultPath);
      await Promise.all(
        files.map(file => fs.rm(path.join(testVaultPath, file), { recursive: true, force: true }))
      );
    } catch {
      // Directory might not exist
    }
  }
});

afterAll(async () => {
  // Clean up test vault
  if (testVaultPath) {
    const parentDir = path.dirname(testVaultPath);
    await fs.rm(parentDir, { recursive: true, force: true });
  }
});

export { testVaultPath };