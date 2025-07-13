/**
 * Tests for context parser
 */

import { TestRunner, assert, createTempDir, cleanupTempDir } from './test-runner.js';
import { 
  readContextFile, 
  writeContextFile, 
  contextFileExists,
  findNearestContextFile,
  listContextFiles
} from '../../mastra/core/context/parser.js';
import type { DomeContext } from '../../mastra/core/context/types.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const runner = new TestRunner();

runner.test('writes and reads context file', async () => {
  const tempDir = await createTempDir();
  
  try {
    const context: DomeContext = {
      name: 'Test Context',
      description: 'Test description',
      rules: {
        fileNaming: 'YYYY-MM-DD-{title}',
        autoTags: ['test']
      }
    };
    
    const contextPath = join(tempDir, '.dome');
    await writeContextFile(contextPath, context);
    
    const exists = await contextFileExists(contextPath);
    assert(exists, 'Context file should exist');
    
    const readContext = await readContextFile(contextPath);
    assert(readContext !== null, 'Should read context');
    assert(readContext!.name === context.name, 'Name should match');
    assert(readContext!.description === context.description, 'Description should match');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('returns null for non-existent file', async () => {
  const context = await readContextFile('/non/existent/path/.dome');
  assert(context === null, 'Should return null for non-existent file');
});

runner.test('finds nearest context file', async () => {
  const tempDir = await createTempDir();
  
  try {
    // Create nested structure
    const rootContext = join(tempDir, '.dome');
    const subDir = join(tempDir, 'subdir');
    const deepDir = join(tempDir, 'subdir', 'deep');
    
    await mkdir(subDir, { recursive: true });
    await mkdir(deepDir, { recursive: true });
    
    // Write root context
    await writeContextFile(rootContext, {
      name: 'Root',
      description: 'Root context'
    });
    
    // Search from deep directory
    const result = await findNearestContextFile(deepDir);
    assert(result !== null, 'Should find context');
    assert(result!.depth === 2, 'Should be 2 levels up');
    assert(result!.path === rootContext, 'Should find root context');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('lists all context files', async () => {
  const tempDir = await createTempDir();
  
  try {
    // Create multiple contexts
    const dir1 = join(tempDir, 'dir1');
    const dir2 = join(tempDir, 'dir2');
    
    await mkdir(dir1);
    await mkdir(dir2);
    
    await writeContextFile(join(dir1, '.dome'), {
      name: 'Context 1',
      description: 'First context'
    });
    
    await writeContextFile(join(dir2, '.dome'), {
      name: 'Context 2', 
      description: 'Second context'
    });
    
    const files = await listContextFiles(tempDir);
    assert(files.length === 2, 'Should find 2 context files');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

// Run tests
runner.run();