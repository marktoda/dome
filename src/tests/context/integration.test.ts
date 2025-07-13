/**
 * Integration tests for context-aware note operations
 */

import { TestRunner, assert, createTempDir, cleanupTempDir } from './test-runner.js';
import { writeNoteWithContext } from '../../mastra/core/context/notes-integration.js';
import { ContextManager } from '../../mastra/core/context/manager.js';
import type { DomeContext } from '../../mastra/core/context/types.js';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import matter from 'gray-matter';

const runner = new TestRunner();

runner.test('creates note with context template', async () => {
  const tempDir = await createTempDir();
  // Override vault path for test
  process.env.DOME_VAULT_PATH = tempDir;
  
  try {
    const manager = new ContextManager(tempDir);
    
    // Create meetings context
    const meetingsDir = join(tempDir, 'meetings');
    await mkdir(meetingsDir);
    
    const context: DomeContext = {
      name: 'Meetings',
      description: 'Meeting notes',
      template: {
        frontmatter: {
          attendees: [],
          action_items: [],
          type: 'meeting'
        },
        content: '# Meeting: {title}\nDate: {date}\n\n## Agenda\n\n## Discussion'
      },
      rules: {
        fileNaming: 'YYYY-MM-DD-{title}',
        requiredFields: ['attendees'],
        autoTags: ['meeting']
      }
    };
    
    await manager.createContext(meetingsDir, context);
    
    // Create a note
    const result = await writeNoteWithContext({
      path: 'meetings/standup',
      content: 'Team discussed project progress',
      title: 'Weekly Standup',
      tags: ['team'],
      respectContext: true
    });
    
    assert(result.contextApplied, 'Context should be applied');
    assert(result.contextName === 'Meetings', 'Should use meetings context');
    assert(result.path.match(/meetings\/\d{4}-\d{2}-\d{2}-weekly-standup\.md/), 'Should use date pattern');
    
    // Read the created note
    const noteContent = await readFile(result.fullPath, 'utf-8');
    const parsed = matter(noteContent);
    
    assert(parsed.data.type === 'meeting', 'Should have meeting type');
    assert(parsed.data.tags.includes('meeting'), 'Should have meeting tag');
    assert(parsed.data.tags.includes('team'), 'Should have user tag');
    assert(parsed.content.includes('# Meeting: Weekly Standup'), 'Should use template');
    assert(parsed.content.includes('Team discussed project progress'), 'Should include user content');
  } finally {
    delete process.env.DOME_VAULT_PATH;
    await cleanupTempDir(tempDir);
  }
});

runner.test('respects context inheritance', async () => {
  const tempDir = await createTempDir();
  process.env.DOME_VAULT_PATH = tempDir;
  
  try {
    const manager = new ContextManager(tempDir);
    
    // Create parent context
    const parentContext: DomeContext = {
      name: 'Projects',
      description: 'All projects',
      rules: {
        autoTags: ['project']
      }
    };
    
    await manager.createContext(tempDir, parentContext);
    
    // Create child directory without context
    const projectDir = join(tempDir, 'myproject');
    await mkdir(projectDir);
    
    // Create note in child directory
    const result = await writeNoteWithContext({
      path: 'myproject/README',
      content: 'Project documentation',
      title: 'My Project',
      respectContext: true
    });
    
    assert(result.contextApplied, 'Parent context should be applied');
    
    // Read the note
    const noteContent = await readFile(result.fullPath, 'utf-8');
    const parsed = matter(noteContent);
    
    assert(parsed.data.tags.includes('project'), 'Should inherit parent auto-tag');
  } finally {
    delete process.env.DOME_VAULT_PATH;
    await cleanupTempDir(tempDir);
  }
});

runner.test('creates note without context when disabled', async () => {
  const tempDir = await createTempDir();
  process.env.DOME_VAULT_PATH = tempDir;
  
  try {
    const manager = new ContextManager(tempDir);
    
    // Create context
    const context: DomeContext = {
      name: 'Strict Context',
      description: 'Has many rules',
      rules: {
        fileNaming: 'STRICT-{title}',
        autoTags: ['strict']
      }
    };
    
    await manager.createContext(tempDir, context);
    
    // Create note with context disabled
    const result = await writeNoteWithContext({
      path: 'simple-note.md',
      content: 'Just a simple note',
      title: 'Simple',
      respectContext: false
    });
    
    assert(!result.contextApplied, 'Context should not be applied');
    assert(result.path === 'simple-note.md', 'Should use provided path');
    
    // Read the note
    const noteContent = await readFile(result.fullPath, 'utf-8');
    const parsed = matter(noteContent);
    
    assert(!parsed.data.tags || !parsed.data.tags.includes('strict'), 'Should not have context tags');
  } finally {
    delete process.env.DOME_VAULT_PATH;
    await cleanupTempDir(tempDir);
  }
});

runner.test('appends to existing note', async () => {
  const tempDir = await createTempDir();
  process.env.DOME_VAULT_PATH = tempDir;
  
  try {
    // Create initial note
    const result1 = await writeNoteWithContext({
      path: 'journal.md',
      content: 'First entry',
      title: 'My Journal',
      respectContext: true
    });
    
    assert(result1.action === 'created', 'Should create note');
    
    // Append to note
    const result2 = await writeNoteWithContext({
      path: 'journal.md',
      content: 'Second entry',
      respectContext: true
    });
    
    assert(result2.action === 'appended', 'Should append to note');
    assert(!result2.contextApplied, 'Context should not be applied on append');
    
    // Read the note
    const noteContent = await readFile(result2.fullPath, 'utf-8');
    const parsed = matter(noteContent);
    
    assert(parsed.content.includes('First entry'), 'Should have first entry');
    assert(parsed.content.includes('Second entry'), 'Should have second entry');
    assert(parsed.data.modified, 'Should have modified timestamp');
  } finally {
    delete process.env.DOME_VAULT_PATH;
    await cleanupTempDir(tempDir);
  }
});

// Run tests
runner.run();