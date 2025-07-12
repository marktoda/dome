import { AINoteFinder } from '../actions/note-finder.js';
import { DefaultEditorService } from '../services/editor-service.js';

export async function handleFind(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
    const editor = new DefaultEditorService();
    
    console.log(`🔍 Searching for existing notes matching "${topic}"...`);
    
    // Find existing note only
    const result = await finder.findExistingNote(topic);
    
    if (!result) {
      console.error(`❌ No existing note found matching "${topic}"`);
      process.exit(1);
    }
    
    console.log(`📖 Opening existing note: ${result.path}`);
    
    // Open in editor
    const success = await editor.openNote(result.path, false);
    
    if (success) {
      console.log('✅ Note opened successfully');
    } else {
      console.error('❌ Error opening note');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Failed to find note:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}