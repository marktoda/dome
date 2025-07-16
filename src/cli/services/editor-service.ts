import { basename } from 'node:path';
import { editorManager } from './editor-manager.js';
import type { RelPath } from '../../mastra/utils/path-utils.js';

export interface EditorService {
  openNote(path: string, isNew: boolean): Promise<boolean>;
  detectEditor(): string;
}

/**
 * Legacy editor service that delegates to the new EditorManager
 * for backwards compatibility
 */
export class DefaultEditorService implements EditorService {
  detectEditor(): string {
    return (
      process.env.EDITOR ||
      process.env.VISUAL ||
      (process.platform === 'win32' ? 'notepad' : 'nano')
    );
  }

  async openNote(relPath: string, isNew: boolean): Promise<boolean> {
    // Delegate to the new EditorManager
    return editorManager.openEditor({
      path: relPath,
      isNew,
    });
  }

  private extractTitle(path: string): string {
    return basename(path, '.md')
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private editorExists(editor: string): Promise<boolean> {
    // This is now handled internally by EditorManager
    return Promise.resolve(true);
  }
}
