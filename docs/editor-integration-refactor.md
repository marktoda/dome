# Editor Integration Refactoring

## Overview

The editor integration in the Dome TUI has been completely refactored to address several critical issues:

1. **Severe flickering** when transitioning between the TUI and external editor
2. **Key binding conflicts** causing phantom keystrokes and the TUI reopening the editor
3. **Poor state management** between the TUI and external processes
4. **Lack of proper terminal state handling** during editor sessions

## Architecture Changes

### New EditorManager Service

The core of the refactoring is the new `EditorManager` class (`src/cli/services/editor-manager.ts`), which provides:

```typescript
export class EditorManager extends EventEmitter {
  // Centralized state management
  private state: EditorState = {
    isOpen: boolean;
    isTransitioning: boolean;
    editorPid?: number;
    lastCloseTime: number;
  };

  // Event-driven architecture
  async openEditor(options: EditorOptions): Promise<boolean>
  canOpenEditor(minDelayMs: number = 500): boolean
  forceClose(): Promise<void>
}
```

### Key Improvements

#### 1. **State Management**

- Centralized editor state tracking with `EditorState` interface
- Event-driven updates via EventEmitter pattern
- Transition states to prevent race conditions
- Timestamp tracking to prevent phantom keystrokes

#### 2. **Terminal State Handling**

The new system properly manages terminal transitions:

```typescript
private async prepareTerminal(): Promise<TerminalState> {
  // 1. Exit raw mode
  // 2. Pause stdin to stop Ink input processing
  // 3. Clear input buffer
  // 4. Exit alternate screen buffer
  // 5. Show cursor
  // 6. Disable stdout writes from Ink
}

private async restoreTerminal(state: TerminalState): Promise<void> {
  // 1. Restore stdout writes
  // 2. Return to alternate screen
  // 3. Clear screen artifacts
  // 4. Resume stdin
  // 5. Restore raw mode with delay
  // 6. Terminal stabilization delay
}
```

#### 3. **Input Coordination**

- The TUI now checks editor state before processing any keyboard input
- Minimum delay enforcement between editor sessions (default 500ms)
- Input buffer clearing to prevent phantom keystrokes
- Proper focus management after editor closes

#### 4. **Visual Feedback**

- Editor status banner shows when editor is open or transitioning
- Note panel border changes color when editor is active
- Clear visual indication of terminal state

### Integration with ChatApp

The `ChatApp` component now integrates cleanly with the EditorManager:

```typescript
// Subscribe to editor state changes
useEffect(() => {
  const handleStateChange = state => setEditorState(state);
  editorManager.on('state:changed', handleStateChange);
  return () => editorManager.off('state:changed', handleStateChange);
}, []);

// Block input when editor is active
useInput((input, key) => {
  if (editorState.isOpen || editorState.isTransitioning) {
    return; // Ignore all input
  }
  // ... normal input handling
});
```

### Benefits

1. **No More Flickering**: Proper screen buffer management eliminates visual artifacts
2. **Clean Transitions**: State-based transitions prevent race conditions
3. **No Phantom Keystrokes**: Input buffer clearing and delay management
4. **Better UX**: Visual feedback and proper focus management
5. **Robust Error Handling**: Graceful recovery from editor crashes

## Migration Guide

### For Existing Code

The `DefaultEditorService` has been updated to delegate to the new `EditorManager` for backwards compatibility:

```typescript
// Old way (still works)
const editor = new DefaultEditorService();
await editor.openNote(path, isNew);

// New way (recommended)
await editorManager.openEditor({
  path,
  isNew,
  onOpen: () => console.log('Editor opened'),
  onClose: success => console.log('Editor closed:', success),
  onError: error => console.error('Error:', error),
});
```

### For New Features

Use the EditorManager directly to take advantage of:

- Event-based state updates
- Transition detection
- Force close capabilities
- Minimum delay enforcement

## Technical Details

### Terminal Control Sequences

The refactored system uses proper ANSI escape sequences:

- `\u001b[?1049l` - Exit alternate screen buffer (show editor)
- `\u001b[?1049h` - Enter alternate screen buffer (return to TUI)
- `\u001b[?25h` - Show cursor
- `\u001b[2J\u001b[H` - Clear screen and home cursor

### Process Management

- Proper process spawning with inherited stdio
- SIGTERM/SIGKILL handling for force close
- Exit code tracking for success/failure detection

### Event Flow

1. User presses Tab on a note (regular Enter is for chat messages)
2. EditorManager checks `canOpenEditor()`
3. Terminal prepared for external editor
4. Editor process spawned
5. State transitions tracked via events
6. Terminal restored after editor exit
7. Minimum delay enforced before next open

## Future Enhancements

1. **Multiple Editor Support**: Queue multiple editor requests
2. **Split Screen Mode**: Keep part of TUI visible while editing
3. **Editor Profiles**: Different settings for different editors
4. **Session Recovery**: Restore editor state after TUI crash
