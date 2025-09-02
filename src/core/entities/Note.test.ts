import { describe, it, expect } from 'vitest';
import type { NoteId, NoteMeta, RawNote, Note } from './Note.js';

describe('Note Entity Types', () => {
  describe('NoteId', () => {
    it('should accept valid relative paths', () => {
      const validIds: NoteId[] = [
        'note.md',
        'folder/note.md',
        'deep/nested/folder/note.md',
        'my-note.md',
        'note_2024.md',
        'note (draft).md',
        'notes/2024-01-01.md',
        'inbox/quick-note.md'
      ];

      // Type checking - if this compiles, the types are correct
      expect(validIds).toBeDefined();
      expect(validIds.length).toBeGreaterThan(0);
    });

    it('should handle edge case paths', () => {
      const edgeCases: NoteId[] = [
        '', // Empty path (root)
        '.md', // Hidden file
        'folder/.hidden.md',
        'note.markdown',
        'note.txt', // Non-markdown extension
        'folder/sub/../note.md', // Path with navigation
      ];

      expect(edgeCases).toBeDefined();
    });
  });

  describe('NoteMeta', () => {
    it('should have all required fields', () => {
      const meta: NoteMeta = {
        id: 'notes/example.md',
        title: 'Example Note',
        date: '2024-01-01T00:00:00Z',
        tags: ['test', 'example'],
        path: 'notes/example.md'
      };

      expect(meta.id).toBe('notes/example.md');
      expect(meta.title).toBe('Example Note');
      expect(meta.date).toBe('2024-01-01T00:00:00Z');
      expect(meta.tags).toEqual(['test', 'example']);
      expect(meta.path).toBe('notes/example.md');
    });

    it('should handle empty tags array', () => {
      const meta: NoteMeta = {
        id: 'note.md',
        title: 'No Tags',
        date: '2024-01-01T00:00:00Z',
        tags: [],
        path: 'note.md'
      };

      expect(meta.tags).toEqual([]);
      expect(meta.tags.length).toBe(0);
    });

    it('should handle various title formats', () => {
      const metas: NoteMeta[] = [
        {
          id: 'note.md',
          title: 'Simple Title',
          date: '2024-01-01T00:00:00Z',
          tags: [],
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: '', // Empty title
          date: '2024-01-01T00:00:00Z',
          tags: [],
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Title with Special Characters !@#$%^&*()',
          date: '2024-01-01T00:00:00Z',
          tags: [],
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: '123', // Numeric title
          date: '2024-01-01T00:00:00Z',
          tags: [],
          path: 'note.md'
        }
      ];

      expect(metas).toHaveLength(4);
      expect(metas[0].title).toBe('Simple Title');
      expect(metas[1].title).toBe('');
      expect(metas[2].title).toContain('Special Characters');
      expect(metas[3].title).toBe('123');
    });

    it('should handle various date formats', () => {
      const metas: NoteMeta[] = [
        {
          id: 'note.md',
          title: 'Date Test',
          date: '2024-01-01T00:00:00Z', // ISO format with Z
          tags: [],
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Date Test',
          date: '2024-01-01T00:00:00.000Z', // ISO format with milliseconds
          tags: [],
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Date Test',
          date: '2024-01-01', // Date only
          tags: [],
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Date Test',
          date: '', // Empty date
          tags: [],
          path: 'note.md'
        }
      ];

      expect(metas[0].date).toBe('2024-01-01T00:00:00Z');
      expect(metas[1].date).toBe('2024-01-01T00:00:00.000Z');
      expect(metas[2].date).toBe('2024-01-01');
      expect(metas[3].date).toBe('');
    });

    it('should handle various tag configurations', () => {
      const metas: NoteMeta[] = [
        {
          id: 'note.md',
          title: 'Tag Test',
          date: '2024-01-01',
          tags: [], // Empty array
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Tag Test',
          date: '2024-01-01',
          tags: ['single'], // Single tag
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Tag Test',
          date: '2024-01-01',
          tags: ['tag1', 'tag2', 'tag3'], // Multiple tags
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Tag Test',
          date: '2024-01-01',
          tags: ['tag-with-dash', 'tag_with_underscore', 'tag.with.dots'], // Special characters
          path: 'note.md'
        },
        {
          id: 'note.md',
          title: 'Tag Test',
          date: '2024-01-01',
          tags: ['', 'empty-tag'], // Empty string tag
          path: 'note.md'
        }
      ];

      expect(metas[0].tags).toEqual([]);
      expect(metas[1].tags).toEqual(['single']);
      expect(metas[2].tags).toEqual(['tag1', 'tag2', 'tag3']);
      expect(metas[3].tags).toEqual(['tag-with-dash', 'tag_with_underscore', 'tag.with.dots']);
      expect(metas[4].tags).toEqual(['', 'empty-tag']);
    });
  });

  describe('RawNote', () => {
    it('should have all required fields', () => {
      const raw: RawNote = {
        id: 'notes/example.md',
        body: '# Example\n\nThis is the note content.',
        fullPath: '/home/user/vault/notes/example.md'
      };

      expect(raw.id).toBe('notes/example.md');
      expect(raw.body).toBe('# Example\n\nThis is the note content.');
      expect(raw.fullPath).toBe('/home/user/vault/notes/example.md');
    });

    it('should handle various body content', () => {
      const notes: RawNote[] = [
        {
          id: 'empty.md',
          body: '', // Empty body
          fullPath: '/vault/empty.md'
        },
        {
          id: 'markdown.md',
          body: '# Heading\n\n## Subheading\n\n- List item\n- Another item\n\n**Bold** and *italic*',
          fullPath: '/vault/markdown.md'
        },
        {
          id: 'frontmatter.md',
          body: '---\ntitle: Note\ntags: [test]\n---\n\nContent',
          fullPath: '/vault/frontmatter.md'
        },
        {
          id: 'code.md',
          body: '```javascript\nconst x = 42;\n```\n\nCode example',
          fullPath: '/vault/code.md'
        },
        {
          id: 'unicode.md',
          body: 'Unicode: 你好世界 🌍 émojis 😀',
          fullPath: '/vault/unicode.md'
        }
      ];

      expect(notes[0].body).toBe('');
      expect(notes[1].body).toContain('# Heading');
      expect(notes[2].body).toContain('---');
      expect(notes[3].body).toContain('```javascript');
      expect(notes[4].body).toContain('🌍');
    });

    it('should handle various path formats', () => {
      const notes: RawNote[] = [
        {
          id: 'note.md',
          body: 'Content',
          fullPath: '/home/user/vault/note.md' // Unix absolute path
        },
        {
          id: 'note.md',
          body: 'Content',
          fullPath: 'C:\\Users\\User\\vault\\note.md' // Windows absolute path
        },
        {
          id: 'note.md',
          body: 'Content',
          fullPath: '/vault/folder with spaces/note.md' // Path with spaces
        },
        {
          id: 'note.md',
          body: 'Content',
          fullPath: '/vault/special-chars_123/note (1).md' // Special characters
        }
      ];

      expect(notes[0].fullPath).toContain('/');
      expect(notes[1].fullPath).toContain('\\');
      expect(notes[2].fullPath).toContain('folder with spaces');
      expect(notes[3].fullPath).toContain('(1)');
    });
  });

  describe('Note (Combined Type)', () => {
    it('should combine NoteMeta and RawNote fields', () => {
      const note: Note = {
        // NoteMeta fields
        id: 'notes/example.md',
        title: 'Example Note',
        date: '2024-01-01T00:00:00Z',
        tags: ['test', 'example'],
        path: 'notes/example.md',
        // RawNote fields
        body: '# Example\n\nThis is the note content.',
        fullPath: '/home/user/vault/notes/example.md'
      };

      // Verify all fields are present
      expect(note.id).toBe('notes/example.md');
      expect(note.title).toBe('Example Note');
      expect(note.date).toBe('2024-01-01T00:00:00Z');
      expect(note.tags).toEqual(['test', 'example']);
      expect(note.path).toBe('notes/example.md');
      expect(note.body).toBe('# Example\n\nThis is the note content.');
      expect(note.fullPath).toBe('/home/user/vault/notes/example.md');
    });

    it('should ensure id and path consistency', () => {
      const note: Note = {
        id: 'folder/note.md',
        title: 'Test Note',
        date: '2024-01-01',
        tags: [],
        path: 'folder/note.md', // Should match id
        body: 'Content',
        fullPath: '/vault/folder/note.md'
      };

      // Currently the type system doesn't enforce id === path
      // but they should be the same in practice
      expect(note.id).toBe(note.path);
      expect(note.fullPath).toContain(note.id);
    });

    it('should handle complete note lifecycle', () => {
      // Create a new note
      const newNote: Note = {
        id: 'new-note.md',
        title: 'New Note',
        date: new Date().toISOString(),
        tags: [],
        path: 'new-note.md',
        body: '# New Note\n\nInitial content',
        fullPath: '/vault/new-note.md'
      };

      // Update the note
      const updatedNote: Note = {
        ...newNote,
        title: 'Updated Note',
        tags: ['updated', 'modified'],
        body: '# Updated Note\n\nModified content'
      };

      expect(updatedNote.id).toBe(newNote.id);
      expect(updatedNote.title).toBe('Updated Note');
      expect(updatedNote.tags).toEqual(['updated', 'modified']);
      expect(updatedNote.body).toContain('Modified content');
    });

    it('should handle notes with minimal data', () => {
      const minimalNote: Note = {
        id: 'minimal.md',
        title: '',
        date: '',
        tags: [],
        path: 'minimal.md',
        body: '',
        fullPath: '/vault/minimal.md'
      };

      expect(minimalNote.title).toBe('');
      expect(minimalNote.date).toBe('');
      expect(minimalNote.tags).toEqual([]);
      expect(minimalNote.body).toBe('');
    });

    it('should handle notes with maximum complexity', () => {
      const complexNote: Note = {
        id: 'complex/nested/path/to/note-2024-01-01.md',
        title: 'Complex Note with Very Long Title That Contains Special Characters !@#$%^&*() and Numbers 123456789',
        date: '2024-01-01T12:34:56.789Z',
        tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'nested-tag', 'another-nested-tag', 'yet-another-tag'],
        path: 'complex/nested/path/to/note-2024-01-01.md',
        body: `---
title: Complex Note
tags: [tag1, tag2, tag3]
date: 2024-01-01
author: Test Author
category: Testing
---

# Complex Note

## Introduction

This is a complex note with multiple sections.

### Subsection 1

Content with **bold**, *italic*, and ~~strikethrough~~.

#### Deep Nesting

- List item 1
  - Nested item 1.1
    - Deeply nested 1.1.1
- List item 2

### Subsection 2

\`\`\`javascript
function example() {
  return "code block";
}
\`\`\`

## Tables

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |

## Links and References

[Link to somewhere](https://example.com)
[[Internal Link]]
![[Embedded Note]]

## Unicode and Emojis

Chinese: 你好世界
Japanese: こんにちは世界
Arabic: مرحبا بالعالم
Emojis: 😀 🎉 🚀 ❤️ 

## Mathematical Expressions

Inline math: $E = mc^2$

Block math:
$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## Footnotes

This is a sentence with a footnote[^1].

[^1]: This is the footnote content.

## Task Lists

- [x] Completed task
- [ ] Incomplete task
- [ ] Another task

---

End of complex note.`,
        fullPath: '/home/user/vault/complex/nested/path/to/note-2024-01-01.md'
      };

      expect(complexNote.id).toContain('complex/nested/path');
      expect(complexNote.title.length).toBeGreaterThan(50);
      expect(complexNote.tags.length).toBe(8);
      expect(complexNote.body).toContain('```javascript');
      expect(complexNote.body).toContain('你好世界');
      expect(complexNote.body).toContain('$E = mc^2$');
      expect(complexNote.body).toContain('- [x] Completed task');
      expect(complexNote.fullPath).toContain(complexNote.id);
    });
  });

  describe('Type Guards and Utilities', () => {
    it('should distinguish between NoteMeta and Note', () => {
      const meta: NoteMeta = {
        id: 'note.md',
        title: 'Test',
        date: '2024-01-01',
        tags: [],
        path: 'note.md'
      };

      const note: Note = {
        ...meta,
        body: 'Content',
        fullPath: '/vault/note.md'
      };

      // Type guard functions (these would be in the actual code)
      const isNoteMeta = (obj: any): obj is NoteMeta => {
        return 'id' in obj && 'title' in obj && 'tags' in obj && !('body' in obj);
      };

      const isNote = (obj: any): obj is Note => {
        return 'id' in obj && 'title' in obj && 'tags' in obj && 'body' in obj && 'fullPath' in obj;
      };

      expect(isNoteMeta(meta)).toBe(true);
      expect(isNoteMeta(note)).toBe(false); // Has body field
      expect(isNote(meta)).toBe(false); // Missing body and fullPath
      expect(isNote(note)).toBe(true);
    });

    it('should handle partial note updates', () => {
      const original: Note = {
        id: 'note.md',
        title: 'Original',
        date: '2024-01-01',
        tags: ['original'],
        path: 'note.md',
        body: 'Original content',
        fullPath: '/vault/note.md'
      };

      // Partial update (only some fields)
      const updates: Partial<Note> = {
        title: 'Updated Title',
        tags: ['updated', 'modified'],
        body: 'Updated content'
      };

      const updated: Note = {
        ...original,
        ...updates
      };

      expect(updated.id).toBe(original.id); // Unchanged
      expect(updated.date).toBe(original.date); // Unchanged
      expect(updated.title).toBe('Updated Title'); // Updated
      expect(updated.tags).toEqual(['updated', 'modified']); // Updated
      expect(updated.body).toBe('Updated content'); // Updated
    });

    it('should handle note collections', () => {
      const notes: Note[] = [
        {
          id: 'note1.md',
          title: 'Note 1',
          date: '2024-01-01',
          tags: ['tag1'],
          path: 'note1.md',
          body: 'Content 1',
          fullPath: '/vault/note1.md'
        },
        {
          id: 'note2.md',
          title: 'Note 2',
          date: '2024-01-02',
          tags: ['tag2'],
          path: 'note2.md',
          body: 'Content 2',
          fullPath: '/vault/note2.md'
        }
      ];

      // Map of notes by ID
      const noteMap = new Map<NoteId, Note>(
        notes.map(note => [note.id, note])
      );

      expect(noteMap.size).toBe(2);
      expect(noteMap.get('note1.md')?.title).toBe('Note 1');
      expect(noteMap.get('note2.md')?.title).toBe('Note 2');

      // Filter notes by tag
      const tag1Notes = notes.filter(note => note.tags.includes('tag1'));
      expect(tag1Notes).toHaveLength(1);
      expect(tag1Notes[0].id).toBe('note1.md');
    });
  });
});