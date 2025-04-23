import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { chat } from '../utils/api';
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
      
      // Create a function to handle streaming chunks
      const handleChunk = (chunk: string) => {
        // Use a callback to ensure we're working with the latest state
        setMessages((prev) => {
          // Find the index of the last assistant message
          const lastAssistantIndex = prev.length - 1;
          
          // Create a new array with all previous messages
          const newMessages = [...prev];
          
          // Make sure we're updating the correct message
          if (lastAssistantIndex >= 0 && newMessages[lastAssistantIndex].role === 'assistant') {
            // Update the content by appending the new chunk
            newMessages[lastAssistantIndex] = {
              ...newMessages[lastAssistantIndex],
              content: newMessages[lastAssistantIndex].content + chunk
            };
          }
          
          return newMessages;
        });
      };
      
      // Send message to API with streaming enabled
      try {
        const response = await chat(content, handleChunk);
        
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
      }
    } catch (err) {
      // Handle general errors
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      setIsLoading(false);
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
            <Text>{message.content}</Text>
          </Box>
        ))}
        
        {isLoading && (
          <Box marginTop={1}>
            <Loading text="Dome is thinking..." />
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