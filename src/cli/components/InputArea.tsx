import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputAreaProps {
  onSubmit: (input: string) => void;
  isDisabled?: boolean;
}

export const InputArea: React.FC<InputAreaProps> = ({ onSubmit, isDisabled = false }) => {
  const [input, setInput] = useState('');

  useInput((inputChar, key) => {
    if (isDisabled) return;

    if (key.return) {
      if (input.trim()) {
        onSubmit(input.trim());
        setInput('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }

    if (key.ctrl) {
      // Handle Ctrl combinations in parent component
      return;
    }

    // Add regular characters
    if (inputChar) {
      setInput(prev => prev + inputChar);
    }
  });

  return (
    <Box paddingX={1} paddingY={1}>
      <Text color="green">{'> '}</Text>
      <Text>
        {input}
        {!isDisabled && <Text backgroundColor="green"> </Text>}
      </Text>
    </Box>
  );
};