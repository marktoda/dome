import { spawn } from 'node:child_process';
import { dirname, basename, extname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { noteStore, NoteId } from '../../mastra/core/note-store.js';
import { toAbs, RelPath, toRel } from '../../mastra/utils/path-utils.js';

export interface EditorService {
  openNote(path: string, isNew: boolean): Promise<boolean>;
  detectEditor(): string;
}

export class DefaultEditorService implements EditorService {
  detectEditor(): string {
    return process.env.EDITOR || 
           process.env.VISUAL || 
           (process.platform === 'win32' ? 'notepad' : 'nano');
  }

  async openNote(relPath: string, isNew: boolean): Promise<boolean> {
    // Accept unknown string but immediately treat it as vault-relative.
    const rel = relPath as RelPath;

    const editor = this.detectEditor();
    const fullPath = toAbs(rel);
    
    try {
      // Ensure directory exists
      await mkdir(dirname(fullPath), { recursive: true });
      
      if (isNew) {
        // Create note with basic template
        const title = this.extractTitle(relPath);
        await this.createNoteTemplate(relPath, title);
      }
      
      // Check if editor exists
      if (!(await this.editorExists(editor))) {
        console.error(`❌ Editor '${editor}' not found. Please set EDITOR environment variable.`);
        console.log('Examples:');
        console.log('  export EDITOR=nano');
        console.log('  export EDITOR=vim');
        console.log('  export EDITOR=code');
        return false;
      }
      
      // Open in editor
      return new Promise((resolve) => {
        const args = this.getEditorArgs(editor, fullPath);
        const child = spawn(editor, args, { 
          stdio: 'inherit' 
        });
        
        child.on('exit', (code) => {
          resolve(code === 0);
        });
        
        child.on('error', (error) => {
          console.error(`❌ Failed to open editor: ${error.message}`);
          resolve(false);
        });
      });
    } catch (error) {
      console.error(`❌ Error opening note: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  private async createNoteTemplate(relPath: string, title: string): Promise<void> {
    const content = `# ${title}\n\n`;
    
    try {
      await noteStore.store(toRel(relPath) as NoteId, content);
    } catch (error) {
      console.error('Failed to create note template:', error);
      throw error;
    }
  }

  private extractTitle(relPath: string): string {
    const filename = basename(relPath, extname(relPath));
    // Convert kebab-case to Title Case
    return filename
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private async editorExists(editor: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('which', [editor], { stdio: 'ignore' });
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  private getEditorArgs(editor: string, fullPath: string): string[] {
    // Special handling for common editors
    switch (basename(editor)) {
      case 'code':
        return ['--wait', fullPath];
      case 'subl':
        return ['--wait', fullPath];
      case 'atom':
        return ['--wait', fullPath];
      default:
        return [fullPath];
    }
  }
}
