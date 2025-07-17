# Keybinding System

This module provides a robust, configurable keybinding system for the Dome Chat TUI.

## Overview

The keybinding system consists of several key components:

1. **KeybindingManager** - Main orchestrator that handles keyboard input
2. **KeybindingRegistry** - Stores and matches keybindings
3. **CommandRegistry** - Stores and executes commands
4. **Context System** - Evaluates when keybindings should be active

## Architecture

### KeybindingManager

The central manager that:
- Receives keyboard input from Ink's `useInput`
- Converts key events to a standardized format
- Finds matching keybindings based on context
- Executes associated commands

### KeybindingRegistry

Manages keybinding definitions:
- Stores keybindings with unique IDs
- Matches pressed keys against registered bindings
- Evaluates context conditions ("when" clauses)
- Supports complex key combinations

### CommandRegistry

Manages command execution:
- Stores command handlers
- Executes commands with optional arguments
- Provides error handling
- Groups commands for organization

## Usage

### Basic Setup

```typescript
import { KeybindingManager } from './keybindings/index.js';
import { useKeybindings } from './hooks/useKeybindings.js';

// In your component
const { getHelpText } = useKeybindings({
  // State
  messages,
  selectedMessageIndex,
  noteLog,
  // ... other state
  
  // Actions
  exit,
  openNoteInEditor,
  addMessage,
  // ... other actions
});
```

### Defining Keybindings

Keybindings are defined with the following structure:

```typescript
{
  id: 'unique.identifier',
  keys: {
    ctrl: true,
    key: 'a'
  },
  command: 'command.to.execute',
  when: 'contextCondition',
  description: 'Human-readable description',
  group: 'Category',
  args: { optional: 'arguments' }
}
```

### Key Combinations

Supported modifiers and special keys:

- **Modifiers**: `ctrl`, `shift`, `alt`, `meta`
- **Arrow Keys**: `upArrow`, `downArrow`, `leftArrow`, `rightArrow`
- **Special Keys**: `tab`, `escape`, `return`, `backspace`, `delete`, `pageUp`, `pageDown`
- **Regular Keys**: Any single character

### Context Conditions

The `when` clause supports simple boolean expressions:

- `editorOpen` - Editor is open
- `!editorOpen` - Editor is not open
- `hasMessages && !processing` - Has messages AND not processing
- `noteLogVisible || helpVisible` - Note log OR help is visible

Available context properties:

- `editorOpen` - Editor window is open
- `editorTransitioning` - Editor is opening/closing
- `processing` - AI is processing a request
- `hasMessages` - Chat has messages
- `hasNoteLog` - Note log has entries
- `noteLogVisible` - Note log panel is visible
- `helpVisible` - Help panel is visible
- `activityVisible` - Activity panel is visible
- `selectedMessageIndex` - A message is selected
- `inputFocused` - Text input has focus

## Extending the System

### Adding New Keybindings

1. Add to `defaultKeybindings.ts`:

```typescript
{
  id: 'custom.action',
  keys: { ctrl: true, key: 'x' },
  command: 'custom.action',
  when: '!editorOpen',
  description: 'Perform custom action',
  group: 'Custom'
}
```

2. Register the command handler in `useKeybindings.ts`:

```typescript
manager.initialize({
  // ... existing commands
  'custom.action': () => {
    // Your custom logic here
  }
});
```

### Adding New Context Properties

1. Add to `KeybindingContext` interface in `types.ts`
2. Update context building in `useKeybindings.ts`
3. Use in keybinding `when` clauses

### Custom Key Handling

For special key handling not covered by the default system:

```typescript
keybindingManager.registerKeybinding({
  id: 'special.key',
  keys: { /* your key combo */ },
  command: 'special.handler',
  when: 'customCondition'
});

keybindingManager.registerCommand(
  'special.handler',
  async () => {
    // Custom handling logic
  }
);
```

## Best Practices

1. **Unique IDs**: Use dot-notation for keybinding IDs (e.g., `module.action`)
2. **Descriptive Commands**: Command IDs should clearly indicate their action
3. **Context Awareness**: Use `when` clauses to prevent conflicts
4. **Group Related Items**: Use consistent group names for organization
5. **Document Shortcuts**: Always provide descriptions for user discovery

## Debugging

Enable debug logging:

```typescript
// In KeybindingManager.handleInput
console.log('Keys pressed:', keys);
console.log('Context:', context);
console.log('Matched binding:', binding);
```

## Migration Guide

To migrate from scattered `useInput` handlers:

1. Identify all existing key handlers
2. Convert to keybinding definitions
3. Move logic to command handlers
4. Remove old `useInput` calls
5. Use `useKeybindings` hook instead

Example migration:

```typescript
// Before
useInput((input, key) => {
  if (key.ctrl && input === 'a') {
    toggleActivity();
  }
});

// After
// In defaultKeybindings.ts
{
  id: 'ui.toggleActivity',
  keys: { ctrl: true, key: 'a' },
  command: 'ui.toggleActivity',
  description: 'Toggle activity panel'
}

// In command handler
'ui.toggleActivity': () => toggleActivity()
``` 