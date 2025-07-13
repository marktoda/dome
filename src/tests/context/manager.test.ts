/**
 * Tests for context manager
 */

import { TestRunner, assert, createTempDir, cleanupTempDir, assertDeepEqual } from './test-runner.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import type { DomeContext } from '../../mastra/core/context/types.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const runner = new TestRunner();

runner.test('creates and loads context', async () => {
  const tempDir = await createTempDir();
  
  try {
    const manager = new ContextManager(tempDir);
    const folderPath = join(tempDir, 'test-folder');
    await mkdir(folderPath);
    
    const context: DomeContext = {
      name: 'Test Context',
      description: 'Test description',
      rules: {
        autoTags: ['test-tag']
      }
    };
    
    await manager.createContext(folderPath, context);
    
    const loaded = await manager.loadContext(folderPath);
    assert(loaded !== null, 'Should load context');
    assert(loaded!.name === context.name, 'Name should match');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('finds context for note path', async () => {
  const tempDir = await createTempDir();
  
  try {
    const manager = new ContextManager(tempDir);
    const folderPath = join(tempDir, 'notes');
    const notePath = join(folderPath, 'test.md');
    
    await mkdir(folderPath);
    
    const context: DomeContext = {
      name: 'Notes Context',
      description: 'For notes'
    };
    
    await manager.createContext(folderPath, context);
    
    const result = await manager.findContextForPath(notePath);
    assert(result !== null, 'Should find context');
    assert(result!.context.name === context.name, 'Should find correct context');
    assert(!result!.isInherited, 'Should not be inherited');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('context inheritance', async () => {
  const tempDir = await createTempDir();
  
  try {
    const manager = new ContextManager(tempDir);
    const parentPath = tempDir;
    const childPath = join(tempDir, 'child');
    const deepPath = join(childPath, 'deep');
    const notePath = join(deepPath, 'note.md');
    
    await mkdir(childPath);
    await mkdir(deepPath);
    
    // Create parent context only
    const parentContext: DomeContext = {
      name: 'Parent Context',
      description: 'Parent',
      rules: {
        autoTags: ['parent-tag']
      }
    };
    
    await manager.createContext(parentPath, parentContext);
    
    // Find context from deep path
    const result = await manager.findContextForPath(notePath);
    assert(result !== null, 'Should find inherited context');
    assert(result!.isInherited, 'Should be inherited');
    assert(result!.depth === 2, 'Should be 2 levels up');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('validates note against context', async () => {
  const tempDir = await createTempDir();
  
  try {
    const manager = new ContextManager(tempDir);
    const folderPath = tempDir;
    const notePath = join(folderPath, 'test.md');
    
    const context: DomeContext = {
      name: 'Strict Context',
      description: 'Has rules',
      rules: {
        requiredFields: ['author', 'date'],
        autoTags: ['required-tag']
      }
    };
    
    await manager.createContext(folderPath, context);
    
    // Test with missing fields
    const invalidContent = `---
title: Test Note
---

Content here`;
    
    const validation1 = await manager.validateNoteAgainstContext(notePath, invalidContent);
    assert(!validation1.isValid, 'Should be invalid without required fields');
    assert(validation1.errors.length === 2, 'Should have 2 errors');
    
    // Test with all fields
    const validContent = `---
title: Test Note
author: Test Author
date: 2023-01-01
tags: [required-tag]
---

Content here`;
    
    const validation2 = await manager.validateNoteAgainstContext(notePath, validContent);
    assert(validation2.isValid, 'Should be valid with all fields');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('applies template', async () => {
  const tempDir = await createTempDir();
  
  try {
    const manager = new ContextManager(tempDir);
    
    const context: DomeContext = {
      name: 'Template Context',
      description: 'Has template',
      template: {
        frontmatter: {
          status: 'draft',
          tags: ['template-tag']
        },
        content: '# {title}\n\nCreated on {date}'
      },
      rules: {
        autoTags: ['auto-tag']
      }
    };
    
    const result = manager.applyTemplate(context, {
      title: 'My Note',
      date: '2023-01-01'
    });
    
    assert(result.includes('status: draft'), 'Should include template frontmatter');
    assert(result.includes('template-tag'), 'Should include template tags');
    assert(result.includes('auto-tag'), 'Should include auto tags');
    assert(result.includes('# My Note'), 'Should replace title placeholder');
    assert(result.includes('Created on 2023-01-01'), 'Should replace date placeholder');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

runner.test('generates filename from pattern', async () => {
  const tempDir = await createTempDir();
  
  try {
    const manager = new ContextManager(tempDir);
    
    const context: DomeContext = {
      name: 'Filename Context',
      description: 'Has naming rules',
      rules: {
        fileNaming: 'YYYY-MM-DD-{title}'
      }
    };
    
    const filename = manager.generateFilename(context, 'Meeting Notes');
    assert(filename.match(/\d{4}-\d{2}-\d{2}-meeting-notes\.md/), 'Should match pattern');
  } finally {
    await cleanupTempDir(tempDir);
  }
});

// Run tests
runner.run();