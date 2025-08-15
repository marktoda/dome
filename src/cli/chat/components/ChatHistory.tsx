import React, { useMemo } from 'react';
import { Box, Text, Static } from 'ink';
import { ChatMessage } from '../state/types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { COLORS, STREAMING, LIMITS } from '../constants.js';

interface ChatHistoryProps {
  messages: ChatMessage[];
  timestampMode: 'off' | 'relative' | 'absolute';
  selectedMessageIndex: number;
}

// Helper component to render a single message row
const MessageRow = React.memo<{
  message: ChatMessage;
  isSelected: boolean;
  showCursor: boolean;
  timestampMode: 'off' | 'relative' | 'absolute';
}>(
  ({ message, isSelected, showCursor, timestampMode }) => {
    const isLong = message.content.length > LIMITS.COLLAPSE_THRESHOLD;
    const canCollapse = message.type === 'assistant' && isLong;

    // Memoize timestamp calculation
    const timestamp = useMemo(() => {
      const now = new Date();
      const diffMs = now.getTime() - message.timestamp.getTime();
      if (timestampMode === 'off') return '';
      if (timestampMode === 'absolute') {
        return message.timestamp.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        });
      }
      // relative
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      return `${Math.floor(diffHours / 24)}d ago`;
    }, [timestampMode, message.timestamp]);

    let displayContent = message.content;
    if (message.isCollapsed && canCollapse) {
      const preview = message.content.substring(0, 80).replace(/\n/g, ' ');
      displayContent = `${preview}... [${message.content.length} chars, press 's' to expand]`;
    }

    const getColor = (type: ChatMessage['type']) => {
      switch (type) {
        case 'user':
          return COLORS.you;
        case 'assistant':
          return COLORS.dome;
        case 'system':
          return COLORS.system;
        case 'error':
          return COLORS.error;
        default:
          return COLORS.white;
      }
    };

    const getPrefix = (type: ChatMessage['type']) => {
      switch (type) {
        case 'user':
          return '[You]    ';
        case 'assistant':
          return '[Dome]   ';
        case 'system':
          return '[System] ';
        case 'error':
          return '[Error]  ';
        default:
          return '';
      }
    };

    return (
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle={isSelected && canCollapse ? 'single' : undefined}
        borderColor={isSelected ? 'yellow' : undefined}
      >
        <Box marginBottom={message.type === 'assistant' ? 1 : 0}>
          <Text color={getColor(message.type)} bold>
            {getPrefix(message.type)}
          </Text>
          {timestamp && <Text color="gray"> {timestamp}</Text>}
        </Box>
        {(message.type === 'assistant' || message.type === 'system') && !message.isCollapsed ? (
          <Box>
            <MarkdownRenderer
              content={displayContent}
              color={message.type === 'system' ? 'blue' : 'white'}
            />
            {message.type === 'assistant' && message.isStreaming && showCursor && (
              <Text color={COLORS.you}>{STREAMING.CURSOR}</Text>
            )}
          </Box>
        ) : (
          <Text color={message.type === 'error' ? 'red' : undefined}>{displayContent}</Text>
        )}
        {canCollapse && !message.isCollapsed && isSelected && (
          <Box marginTop={1}>
            <Text color="yellow">[press 's' to collapse]</Text>
          </Box>
        )}
      </Box>
    );
  },
  // Custom comparison function - only re-render if content or key props change
  (prevProps, nextProps) => {
    return (
      prevProps.message.content === nextProps.message.content &&
      prevProps.message.isCollapsed === nextProps.message.isCollapsed &&
      prevProps.message.isStreaming === nextProps.message.isStreaming &&
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.showCursor === nextProps.showCursor &&
      prevProps.timestampMode === nextProps.timestampMode
    );
  }
);

// Pull getColor and getPrefix outside component to avoid recreating functions
const getColor = (type: ChatMessage['type']) => {
  switch (type) {
    case 'user':
      return COLORS.you;
    case 'assistant':
      return COLORS.dome;
    case 'system':
      return COLORS.system;
    case 'error':
      return COLORS.error;
    default:
      return COLORS.white;
  }
};

const getPrefix = (type: ChatMessage['type']) => {
  switch (type) {
    case 'user':
      return '[You]    ';
    case 'assistant':
      return '[Dome]   ';
    case 'system':
      return '[System] ';
    case 'error':
      return '[Error]  ';
    default:
      return '';
  }
};

export const ChatHistory = React.memo<ChatHistoryProps>(
  ({ messages, timestampMode, selectedMessageIndex }) => {
    // No blinking cursor to avoid extra re-renders
    const showCursor = true;

    // Split static vs streaming message to leverage <Static> optimisation
    // Memoize to keep array references stable
    const recentMessages = useMemo(() => messages.slice(-LIMITS.MAX_MESSAGES), [messages]);

    const staticMessages = useMemo(
      () => recentMessages.slice(0, -1),
      [recentMessages.length] // Only recalculate when length changes
    );

    const streamingMessage = recentMessages[recentMessages.length - 1];

    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1} overflow="hidden">
        <Static items={staticMessages}>
          {(msg: ChatMessage) => (
            <MessageRow
              key={msg.id}
              message={msg}
              isSelected={messages.indexOf(msg) === selectedMessageIndex}
              showCursor={false}
              timestampMode={timestampMode}
            />
          )}
        </Static>

        {streamingMessage && (
          <MessageRow
            key={streamingMessage.id}
            message={streamingMessage}
            isSelected={messages.length - 1 === selectedMessageIndex}
            showCursor={!!(showCursor && streamingMessage.isStreaming)}
            timestampMode={timestampMode}
          />
        )}
      </Box>
    );
  }
);

ChatHistory.displayName = 'ChatHistory';
