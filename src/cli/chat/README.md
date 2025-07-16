# Dome Chat TUI Module

This module contains all the components, state management, and utilities for the Dome Chat Terminal User Interface (TUI).

## Directory Structure

```
chat/
├── components/       # React Ink components
│   ├── ActivityPanel.tsx      # Activity monitor panel
│   ├── BottomStatusBar.tsx    # Indexing status bar
│   ├── ChatApp.tsx            # Main chat application
│   ├── ChatHistory.tsx        # Message display area
│   ├── FullscreenLayout.tsx   # Layout manager
│   ├── HelpPanel.tsx          # Help panel
│   ├── InputArea.tsx          # User input component
│   ├── MarkdownRenderer.tsx   # Markdown to ANSI renderer
│   └── StatusBar.tsx          # Top status bar
├── state/           # State management (Context + useReducer)
│   ├── AppContext.tsx         # React Context provider
│   ├── activityReducer.ts     # Activity state reducer
│   ├── chatReducer.ts         # Chat messages reducer
│   ├── rootReducer.ts         # Combined reducer
│   └── types.ts               # TypeScript type definitions
├── hooks/           # Custom React hooks
│   ├── useMessageRenderer.ts  # Message rendering optimization
│   ├── useStream.ts           # Character-by-character streaming
│   └── useVaultIndexer.ts     # Worker thread integration
├── services/        # Service classes
│   └── IndexWorker.ts         # Worker thread management
├── worker/          # Worker thread scripts
│   └── indexer.ts             # Background indexing worker
├── utils/           # Utility functions
│   ├── activityTracker.ts     # Activity tracking utilities
│   └── errorHandler.ts        # Error handling with retry
├── constants.ts     # Configuration constants
└── index.ts         # Module exports

```

## Architecture

The chat module follows a clean architecture pattern:

1. **State Management**: Centralized state using React Context + useReducer
2. **Component Design**: All components are memoized for performance
3. **Streaming**: Character-by-character streaming at 30 FPS
4. **Background Work**: Indexing runs in worker threads
5. **Error Handling**: Automatic retry with exponential backoff

## Key Features

- **Token Streaming**: Smooth character-by-character display with blinking cursor
- **Rich Markdown**: Full markdown rendering with syntax highlighting
- **Activity Monitor**: Real-time tracking of tool calls and document access
- **Background Indexing**: Non-blocking vault indexing in worker threads
- **Keyboard Navigation**: Arrow keys for message selection, shortcuts for commands
- **Message Management**: Automatic limiting to 50 messages for performance

## Usage

```typescript
import { ChatApp } from '../chat/index.js';

// In your command handler
const { waitUntilExit } = render(<ChatApp />);
await waitUntilExit();
```

## Color Scheme

The module uses a consistent 24-bit RGB color palette:

- **[You]**: #00d7d7 (cyan)
- **[Dome]**: #ff00ff (magenta)
- **[System]**: #5f87ff (blue)
- **[Error]**: #ff5f5f (red)
- **Tool activity**: #00d7d7 (cyan)
- **Document activity**: #5fff87 (green)

## Performance Optimizations

1. All components use `React.memo` to prevent unnecessary re-renders
2. Messages are limited to the last 50 to manage memory
3. Activity list capped at 100 entries
4. Streaming uses requestAnimationFrame-like timing
5. Worker threads prevent UI blocking during indexing
