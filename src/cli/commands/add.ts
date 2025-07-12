import { AINoteFinder } from '../actions/note-finder.js';
import { DefaultEditorService } from '../services/editor-service.js';

export async function handleAdd(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
    const editor = new DefaultEditorService();
    
    console.log(`🔍 Looking for notes matching "${topic}"...`);
    
    // Find existing note or determine new path
    const result = await finder.findNoteOrCategory(topic);
    const targetPath = result.path;
    const isNew = result.type === 'category';
    
    if (isNew) {
      console.log(`📝 Creating new note: ${targetPath}`);
    } else {
      console.log(`📖 Opening existing note: ${targetPath}`);
    }
    
    // Open in editor
    const success = await editor.openNote(targetPath, isNew);
    
    if (success) {
      console.log('✅ Note saved successfully');
    } else {
      console.error('❌ Error saving note');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Failed to handle add command:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}