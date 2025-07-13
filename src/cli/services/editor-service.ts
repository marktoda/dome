import { spawn } from 'node:child_process';
import { join, dirname, basename, extname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeNote } from '../../mastra/core/notes.js';
import { config } from '../../mastra/core/config.js';

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

  async openNote(path: string, isNew: boolean): Promise<boolean> {
    const editor = this.detectEditor();
    const fullPath = join(config.DOME_VAULT_PATH, path);
    
    try {
      // Ensure directory exists
      await mkdir(dirname(fullPath), { recursive: true });
      
      if (isNew) {
        // Create note with basic template
        const title = this.extractTitle(path);
        await this.createNoteTemplate(path, title);
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

  private async createNoteTemplate(path: string, title: string): Promise<void> {
    const content = `# ${title}\n\n`;
    
    try {
      await writeNote(path, content, title);
    } catch (error) {
      console.error('Failed to create note template:', error);
      throw error;
    }
  }

  private extractTitle(path: string): string {
    const filename = basename(path, extname(path));
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
