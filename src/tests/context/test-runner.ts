/**
 * Simple test runner for context system
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}

export class TestRunner {
  private tests: TestCase[] = [];
  private passed = 0;
  private failed = 0;
  
  test(name: string, fn: () => Promise<void> | void) {
    this.tests.push({ name, fn });
  }
  
  async run() {
    console.log('🧪 Running Context System Tests\n');
    
    for (const test of this.tests) {
      try {
        await test.fn();
        this.passed++;
        console.log(`✓ ${test.name}`);
      } catch (error) {
        this.failed++;
        console.log(`✗ ${test.name}`);
        console.error(`  ${error instanceof Error ? error.message : error}`);
      }
    }
    
    console.log(`\n${this.passed} passed, ${this.failed} failed`);
    process.exit(this.failed > 0 ? 1 : 0);
  }
}

export async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dome-test-'));
}

export async function cleanupTempDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

export function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export function assertDeepEqual<T>(actual: T, expected: T, message?: string) {
  const actualStr = JSON.stringify(actual, null, 2);
  const expectedStr = JSON.stringify(expected, null, 2);
  if (actualStr !== expectedStr) {
    throw new Error(
      message || `Objects not equal:\nExpected:\n${expectedStr}\n\nActual:\n${actualStr}`
    );
  }
}