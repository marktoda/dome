import React, { useState, useEffect } from 'react'; // Added useEffect
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Loading from './Loading';
import { getApiClient } from '../utils/apiClient';
import { loadConfig } from '../utils/config';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk'; // SDK imports
import chalk from 'chalk'; // For styling sources, if needed

// Assuming ChatSource is the SDK type for sources
// This might need adjustment based on actual SDK stream chunk structure
type SdkChatMessageChunk =
  | { type: 'content' | 'thinking' | 'unknown'; content: string }
  | {
      type: 'sources';
      data: DomeApi.ChatSource[] | DomeApi.ChatSource; // Changed 'node.sources' to 'data' to match a common SDK pattern
    };

// Adapted from commands/chat.ts - this needs to be verified against actual SDK stream format
interface ChunkDetector {
  (parsedJson: any): SdkChatMessageChunk | null;
}
const detectors: ChunkDetector[] = [
  (parsed) => {
    if (parsed && parsed.type === 'sources' && parsed.data) {
      return { type: 'sources', data: parsed.data as (DomeApi.ChatSource[] | DomeApi.ChatSource) };
    }
    return null;
  },
  (parsed) => {
    if (parsed && parsed.type === 'thinking' && typeof parsed.content === 'string') {
      return { type: 'thinking', content: parsed.content };
    }
    return null;
  },
  (parsed) => {
    if (parsed && parsed.type === 'content' && typeof parsed.content === 'string') {
      return { type: 'content', content: parsed.content };
    }
    return null;
  },
];

const detectSdkChunk = (jsonData: string): SdkChatMessageChunk => {
  try {
    const parsed = JSON.parse(jsonData);
    for (const det of detectors) {
      const match = det(parsed);
      if (match) return match;
    }
    if (parsed && typeof parsed.content === 'string') {
        return { type: 'content', content: parsed.content };
    }
    if (typeof parsed === 'string') {
        return { type: 'content', content: parsed };
    }
  } catch {
    return { type: 'content', content: jsonData };
  }
  return { type: 'unknown', content: jsonData };
};


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
  useEffect(() => {
    if (initialMessage) {
      sendMessage(initialMessage);
    }
  }, [initialMessage]); // Added initialMessage to dependency array

  // Helper to update the assistant's message with actual content or append to it
  const updateAssistantMessage = (contentChunk: string, replace: boolean = false) => {
    setMessages((prevMessages) => {
      const newMessages = [...prevMessages];
      let assistantMsgIndex = newMessages.findIndex(
        (msg, idx) => msg.role === 'assistant' && idx === newMessages.length -1 && !msg.content.startsWith('[Thinking]')
      );

      if (assistantMsgIndex === -1 || newMessages[assistantMsgIndex].content.startsWith('[Thinking]')) {
        // If no suitable assistant message found at the end, or if it's a thinking message, add a new one
        newMessages.push({ role: 'assistant', content: contentChunk });
      } else {
        // Append to existing or replace
        newMessages[assistantMsgIndex] = {
          ...newMessages[assistantMsgIndex],
          content: replace ? contentChunk : newMessages[assistantMsgIndex].content + contentChunk,
        };
      }
      return newMessages;
    });
  };
  
  // Helper to show thinking content
  const showThinkingMessage = (thinkingContent: string) => {
    setMessages((prevMessages) => {
        const newMessages = [...prevMessages];
        // Add or update a dedicated thinking message
        const thinkingMsgIndex = newMessages.findIndex(m => m.role === 'assistant' && m.content.startsWith('[Thinking]'));
        const formattedThinking = `[Thinking] ${thinkingContent.substring(0,100)}${thinkingContent.length > 100 ? '...' : ''}`;
        if(thinkingMsgIndex !== -1){
            newMessages[thinkingMsgIndex].content = formattedThinking;
        } else {
            // Add new thinking message, potentially replacing an empty assistant message placeholder
            const lastMsg = newMessages[newMessages.length -1];
            if(lastMsg && lastMsg.role === 'assistant' && lastMsg.content === ''){
                newMessages[newMessages.length -1] = {role: 'assistant', content: formattedThinking};
            } else {
                 newMessages.push({ role: 'assistant', content: formattedThinking });
            }
        }
        // Ensure there's an empty placeholder for the actual content if not already present
        const lastMessage = newMessages[newMessages.length - 1];
        if (!lastMessage || lastMessage.content.startsWith('[Thinking]') || lastMessage.content !== '') {
             newMessages.push({role: 'assistant', content: ''});
        }
        return newMessages;
    });
  };

  const handleSdkChunk = (chunk: SdkChatMessageChunk) => {
    if (chunk.type === 'thinking') {
      showThinkingMessage(chunk.content);
    } else if (chunk.type === 'content') {
      // Clear any persistent "Thinking" message once real content starts
      setMessages(prev => prev.filter(m => !m.content.startsWith('[Thinking]')));
      updateAssistantMessage(chunk.content);
    } else if (chunk.type === 'sources') {
      // In TUI, sources might be displayed differently or logged.
      // For this component, we can append a formatted string of sources.
      let sourcesText = "\nSources:\n";
      const sources = Array.isArray(chunk.data) ? chunk.data : [chunk.data];
      sources.forEach((source, index) => {
        sourcesText += `[${index + 1}] ${source.title || 'Unnamed Source'} (${source.type}, ID: ${source.id})${source.url ? ` - ${source.url}` : ''}\n`;
      });
      updateAssistantMessage(sourcesText);
    } else if (chunk.type === 'unknown' && chunk.content.trim()) {
      updateAssistantMessage(chunk.content); // Display unknown content
    }
  };


  const sendMessage = async (content: string) => {
    const config = loadConfig();
    if (!config.userId) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: User ID not found. Please login again.' }]);
      return;
    }

    setIsLoading(true);
    if (!initialMessage || messages.length > 0) {
         setMessages((prev) => [...prev, { role: 'user', content }]);
    }
    // Add an empty placeholder for assistant's response immediately
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
    setIsStreaming(true);

    try {
      const apiClient = await getApiClient();
      const currentMessages: DomeApi.PostChatRequestMessagesItem[] = messages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.content.startsWith('[Thinking]') && m.content !== '')) // Exclude placeholder/thinking for history
        .map(m => ({
          role: m.role as DomeApi.PostChatRequestMessagesItemRole,
          content: m.content,
        }));
      // Add the new user message to the history being sent
      currentMessages.push({role: 'user', content});


      const request: DomeApi.PostChatRequest = {
        userId: config.userId,
        messages: currentMessages,
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
          temperature: 0.7,
        },
        stream: true,
      };

      const stream = (await apiClient.chat.sendAChatMessage(request)) as any as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            const sdkChunk = detectSdkChunk(buffer.trim());
            handleSdkChunk(sdkChunk);
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.substring(0, newlineIndex).trim();
          buffer = buffer.substring(newlineIndex + 1);
          if (line) {
            const sdkChunk = detectSdkChunk(line);
            handleSdkChunk(sdkChunk);
          }
        }
      }
    } catch (err: unknown) {
      let errorMessageText = 'An error occurred during chat.';
      if (err instanceof DomeApiError) {
        const apiError = err as DomeApiError;
        errorMessageText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
      } else if (err instanceof DomeApiTimeoutError) {
        const timeoutError = err as DomeApiTimeoutError;
        errorMessageText = `API Timeout Error: ${timeoutError.message}`;
      } else if (err instanceof Error) {
        errorMessageText = err.message;
      }
      updateAssistantMessage(`Error: ${errorMessageText}`, true);
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  // Effect for initial message (if any)
  useEffect(() => {
    if (initialMessage && messages.length === 0) { // Ensure it only runs once for initial message
      sendMessage(initialMessage);
    }
  }, [initialMessage]);


  const handleSubmit = (value: string) => {
    if (value.trim().toLowerCase() === '/exit') {
      onExit();
      return;
    }
    if (value.trim()) {
      sendMessage(value);
    }
    setInput(''); // Clear input after sending
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
