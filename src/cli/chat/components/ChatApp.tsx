import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { mastra } from '../../../mastra/index.js';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
}

export const ChatApp: React.FC = () => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Allow quitting with Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
  });

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Echo user message
    addMessage({ id: `${Date.now()}-u`, role: 'user', content: trimmed });
    setInput('');
    if (trimmed === '/exit') {
      exit();
      return;
    }

    // Ask assistant
    setIsProcessing(true);
    try {
      const agent = await mastra.getAgent('notesAgent');
      const stream = await agent.stream([{ role: 'user', content: trimmed }]);

      let full = '';
      for await (const chunk of stream.textStream) {
        full += chunk;
      }

      addMessage({ id: `${Date.now()}-a`, role: 'assistant', content: full });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addMessage({ id: `${Date.now()}-e`, role: 'error', content: `Error: ${message}` });
    } finally {
      setIsProcessing(false);
    }
  }, [addMessage, exit]);

  const renderMessage = (msg: Message) => {
    const prefix = msg.role === 'user' ? 'You: ' : msg.role === 'assistant' ? 'Dome: ' : 'Error: ';
    const color = msg.role === 'user' ? 'green' : msg.role === 'assistant' ? 'cyan' : 'red';
    return (
      <Box key={msg.id} flexDirection="row" marginBottom={1}>
        <Text color={color}>{prefix}</Text>
        <Text>{msg.content}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="visible">
        {messages.map(renderMessage)}
        {isProcessing && (
          <Text color="cyan">…thinking…</Text>
        )}
      </Box>

      {/* Input area */}
      <Box paddingX={1} marginBottom={1}>
        <Text color="green">{'› '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          focus={!isProcessing}
        />
      </Box>
    </Box>
  );
};
