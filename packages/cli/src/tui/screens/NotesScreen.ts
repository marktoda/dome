import blessed from 'blessed';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';
import { listNotes, addNote } from '../../utils/api';

/**
 * Create the notes screen
 * @param layout The base layout elements
 * @returns The notes screen
 */
export function createNotesScreen(layout: BaseLayoutElements): Screen {
  // Create the main container
  const element = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
  });

  // Create a box for the notes list
  const notesListBox = blessed.list({
    parent: element,
    top: 3,
    left: 0,
    width: '30%',
    height: '100%-6',
    keys: true,
    vi: true,
    mouse: true,
    border: {
      type: 'line',
    },
    style: {
      selected: {
        bg: 'blue',
        fg: 'white',
      },
      border: {
        fg: 'blue',
      },
    },
    scrollable: true,
    alwaysScroll: true,
    items: ['Loading notes...'],
  });

  // Create a box for the note content
  const noteContentBox = blessed.box({
    parent: element,
    top: 3,
    right: 0,
    width: '70%',
    height: '100%-6',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    scrollable: true,
    alwaysScroll: true,
    content: 'Select a note to view its content',
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Create a header
  const headerBox = blessed.box({
    parent: element,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}Notes{/bold}{/center}',
    tags: true,
  });

  // Create a footer with commands
  const footerBox = blessed.box({
    parent: element,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{bold}Commands:{/bold} [a] Add Note | [d] Delete Note | [e] Edit Note | [r] Refresh | [Esc] Back to Menu',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Create a form for adding a new note
  const addNoteForm = blessed.form({
    parent: element,
    top: 'center',
    left: 'center',
    width: 60,
    height: 15,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'green',
      },
    },
    hidden: true,
  });

  // Add a title for the form
  blessed.box({
    parent: addNoteForm,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}Add New Note{/bold}{/center}',
    tags: true,
  });

  // Add a title input
  blessed.text({
    parent: addNoteForm,
    top: 3,
    left: 1,
    content: 'Title:',
  });

  const titleInput = blessed.textbox({
    parent: addNoteForm,
    top: 3,
    left: 8,
    width: '100%-10',
    height: 1,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
  });

  // Add a content input
  blessed.text({
    parent: addNoteForm,
    top: 5,
    left: 1,
    content: 'Content:',
  });

  const contentInput = blessed.textarea({
    parent: addNoteForm,
    top: 6,
    left: 1,
    width: '100%-2',
    height: 5,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
  });

  // Add submit and cancel buttons
  const submitButton = blessed.button({
    parent: addNoteForm,
    bottom: 1,
    left: 10,
    width: 10,
    height: 1,
    content: 'Submit',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'green',
      },
      focus: {
        bg: 'green',
        fg: 'black',
      },
    },
    mouse: true,
  });

  const cancelButton = blessed.button({
    parent: addNoteForm,
    bottom: 1,
    right: 10,
    width: 10,
    height: 1,
    content: 'Cancel',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'red',
      },
      focus: {
        bg: 'red',
        fg: 'black',
      },
    },
    mouse: true,
  });

  // Handle form submission
  submitButton.on('press', async () => {
    const title = titleInput.getValue();
    const content = contentInput.getValue();
    
    if (content.trim()) {
      try {
        await addNote(title, content);
        
        // Clear form and hide it
        titleInput.clearValue();
        contentInput.clearValue();
        addNoteForm.hide();
        
        // Refresh notes list
        await loadNotes();
        
        layout.screen.render();
      } catch (err) {
        // Show error message
        layout.statusBar.setContent(
          ` {bold}Error:{/bold} ${err instanceof Error ? err.message : String(err)} | Press {bold}q{/bold} to quit | {bold}?{/bold} for help`
        );
        layout.screen.render();
      }
    }
  });

  // Handle cancel button
  cancelButton.on('press', () => {
    titleInput.clearValue();
    contentInput.clearValue();
    addNoteForm.hide();
    layout.screen.render();
  });

  // Load notes from API
  async function loadNotes() {
    try {
      const notes = await listNotes();
      
      // Update notes list
      notesListBox.setItems(
        notes.map(note => note.title || `Note ${note.id.substring(0, 8)}`)
      );
      
      // Store the full notes data
      (notesListBox as any).notesData = notes;
      
      layout.screen.render();
    } catch (err) {
      notesListBox.setItems(['Error loading notes']);
      layout.statusBar.setContent(
        ` {bold}Error:{/bold} ${err instanceof Error ? err.message : String(err)} | Press {bold}q{/bold} to quit | {bold}?{/bold} for help`
      );
      layout.screen.render();
    }
  }

  // Handle note selection
  notesListBox.on('select', (item, index) => {
    const notes = (notesListBox as any).notesData;
    if (notes && notes[index]) {
      const note = notes[index];
      noteContentBox.setContent(
        `{bold}Title:{/bold} ${note.title || '(No title)'}\n` +
        `{bold}Created:{/bold} ${new Date(note.createdAt).toLocaleString()}\n` +
        `{bold}Tags:{/bold} ${note.tags?.join(', ') || 'None'}\n\n` +
        `${note.content}`
      );
      layout.screen.render();
    }
  });

  // Key bindings
  element.key('a', () => {
    addNoteForm.show();
    titleInput.focus();
    layout.screen.render();
  });

  element.key('r', async () => {
    await loadNotes();
  });

  element.key('escape', () => {
    if (addNoteForm.visible) {
      addNoteForm.hide();
      layout.screen.render();
    } else {
      layout.sidebar.focus();
    }
  });

  return {
    id: 'notes',
    title: 'Notes',
    element,
    onFocus: async () => {
      // Load notes when the screen is shown
      await loadNotes();
      
      // Focus the notes list
      notesListBox.focus();
    },
  };
}