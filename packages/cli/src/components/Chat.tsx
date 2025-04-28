import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { chat, ChatMessageChunk } from '../utils/api';
import Loading from './Loading';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatProps {
  initialMessage?: string;
  onExit: () => void;
}

/**
 * Interactive chat component
 */
export const Chat: React.FC<ChatProps> = ({ initialMessage, onExit }) => {
  const [messages, setMessages] = useState<Message[]>(
    initialMessage ? [{ role: 'user', content: initialMessage }] : []
  );
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(initialMessage ? true : false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Send initial message if provided
  React.useEffect(() => {
    if (initialMessage) {
      sendMessage(initialMessage);
    }
  }, []);

  const sendMessage = async (content: string) => {
    try {
      setIsLoading(true);

      // Add user message to the list
      if (!initialMessage || messages.length > 0) {
        setMessages((prev) => [...prev, { role: 'user', content }]);
      }

      // Create a placeholder for the assistant's response
      const assistantMessageIndex = messages.length + ((!initialMessage || messages.length > 0) ? 1 : 0);
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
      setIsStreaming(true);

      // Create a function to handle streaming chunks
      const handleChunk = (chunk: string | ChatMessageChunk) => {
        // Handle structured chunks or plain strings
        if (typeof chunk === 'string') {
          // Plain text handling
          updateAssistantMessage(chunk);
        } else {
          // Structured message handling
          if (chunk.type === 'thinking') {
            // For thinking content, show in a separate thinking message
            showThinkingMessage(chunk.content);
          } else if (chunk.type === 'final') {
            // Final chunks with sources don't have content property
            // Sources are displayed in the CLI version, we don't need to do anything here
          } else {
            // Normal content
            updateAssistantMessage(chunk.content);
          }
        }
      };

      // Helper to show thinking content in a separate message
      const showThinkingMessage = (content: string) => {
        setMessages((prev) => {
          // Find the index of the last assistant message
          const lastAssistantIndex = prev.length - 1;
          const newMessages = [...prev];

          // Check if the last message is already a thinking message
          if (lastAssistantIndex >= 0 &&
            newMessages[lastAssistantIndex].role === 'assistant' &&
            newMessages[lastAssistantIndex].content.startsWith('[Thinking]')) {
            // Update existing thinking message
            try {
              // Try to parse as JSON for better formatting
              const jsonObj = JSON.parse(content);
              newMessages[lastAssistantIndex] = {
                ...newMessages[lastAssistantIndex],
                content: `[Thinking] ${JSON.stringify(jsonObj, null, 2)}`
              };
            } catch (e) {
              // Not JSON, just use as is
              newMessages[lastAssistantIndex] = {
                ...newMessages[lastAssistantIndex],
                content: `[Thinking] ${content}`
              };
            }
          } else {
            // Create a new thinking message (removing any empty assistant message)
            if (lastAssistantIndex >= 0 &&
              newMessages[lastAssistantIndex].role === 'assistant' &&
              newMessages[lastAssistantIndex].content === '') {
              // Replace the empty message
              try {
                const jsonObj = JSON.parse(content);
                newMessages[lastAssistantIndex] = {
                  ...newMessages[lastAssistantIndex],
                  content: `[Thinking] ${JSON.stringify(jsonObj, null, 2)}`
                };
              } catch (e) {
                newMessages[lastAssistantIndex] = {
                  ...newMessages[lastAssistantIndex],
                  content: `[Thinking] ${content}`
                };
              }
            } else {
              // Add as a new message
              try {
                const jsonObj = JSON.parse(content);
                newMessages.push({
                  role: 'assistant',
                  content: `[Thinking] ${JSON.stringify(jsonObj, null, 2)}`
                });
              } catch (e) {
                newMessages.push({
                  role: 'assistant',
                  content: `[Thinking] ${content}`
                });
              }
            }

            // Ensure we have an empty assistant message ready for the actual response
            newMessages.push({
              role: 'assistant',
              content: ''
            });
          }

          return newMessages;
        });
      };

      // Helper to update the assistant's message with actual content
      const updateAssistantMessage = (content: string) => {
        // Use a callback to ensure we're working with the latest state
        setMessages((prev) => {
          // Get the latest state of messages
          const newMessages = [...prev];

          // Find the last non-thinking assistant message
          let lastAssistantIndex = -1;
          for (let i = newMessages.length - 1; i >= 0; i--) {
            if (newMessages[i].role === 'assistant' &&
              !newMessages[i].content.startsWith('[Thinking]')) {
              lastAssistantIndex = i;
              break;
            }
          }

          // If we found an assistant message, update it
          if (lastAssistantIndex >= 0) {
            newMessages[lastAssistantIndex] = {
              ...newMessages[lastAssistantIndex],
              content: newMessages[lastAssistantIndex].content + content
            };
          } else {
            // Otherwise create a new assistant message
            newMessages.push({
              role: 'assistant',
              content
            });
          }

          return newMessages;
        });
      };

      // Send message to API with WebSocket streaming
      try {
        // Check for verbose mode in environment variables or command line
        const isVerbose = process.env.DOME_VERBOSE === 'true' ||
                        (typeof process !== 'undefined' && process.argv &&
                        (process.argv.includes('--verbose') || process.argv.includes('-v')));
        
        const response = await chat(content, handleChunk, {
          retryNonStreaming: true,
          debug: isVerbose
        });

        // If the streaming didn't work for some reason, ensure we have the complete response
        if (response && typeof response === 'object' && response.response) {
          setMessages((prev) => {
            const newMessages = [...prev];
            if (newMessages[assistantMessageIndex]) {
              // Replace with the complete response if needed
              if (newMessages[assistantMessageIndex].content === '') {
                newMessages[assistantMessageIndex] = {
                  ...newMessages[assistantMessageIndex],
                  content: response.response
                };
              }
            }
            return newMessages;
          });
        }

        setIsLoading(false);
        setIsStreaming(false);
      } catch (chatError) {
        // Handle chat-specific errors
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        setMessages((prev) => {
          const newMessages = [...prev];
          if (newMessages[assistantMessageIndex]) {
            newMessages[assistantMessageIndex] = {
              ...newMessages[assistantMessageIndex],
              content: `Error: ${errorMessage}`
            };
          }
          return newMessages;
        });
        setIsLoading(false);
        setIsStreaming(false);
      }
    } catch (err) {
      // Handle general errors
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const handleSubmit = (value: string) => {
    if (value.trim() === '/exit') {
      onExit();
      return;
    }

    sendMessage(value);
    setInput('');
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Chat with Dome</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {messages.map((message, index) => (
          <Box key={index} flexDirection="column" marginBottom={1}>
            <Text bold color={message.role === 'user' ? 'green' : 'blue'}>
              {message.role === 'user' ? 'You: ' : 'Dome: '}
            </Text>
            {message.content.startsWith('[Thinking]') ? (
              <Text color="gray">{message.content}</Text>
            ) : (
              <Text>{message.content}</Text>
            )}
          </Box>
        ))}

        {isLoading && !isStreaming && (
          <Box marginTop={1}>
            <Loading text="Dome is thinking..." />
          </Box>
        )}
        {isStreaming && (
          <Box marginTop={1}>
            <Text color="yellow">Streaming response...</Text>
          </Box>
        )}
      </Box>

      <Box>
        <Box marginRight={1}>
          <Text bold color="green">You: </Text>
        </Box>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type your message (or /exit to quit)"
        />
      </Box>

      <Box marginTop={1}>
        <Text color="gray">Type /exit to end the chat session</Text>
      </Box>
    </Box>
  );
};

export default Chat;
