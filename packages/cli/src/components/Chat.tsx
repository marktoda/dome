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
      
      // Send message to API
      const response = await chat(content);
      
      // Add assistant response to the list
      setMessages((prev) => [...prev, { role: 'assistant', content: response.message }]);
      
      setIsLoading(false);
    } catch (err) {
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