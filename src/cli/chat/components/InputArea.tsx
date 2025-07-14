import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS } from '../constants.js';

interface InputAreaProps {
  onSubmit: (input: string) => void;
  isDisabled?: boolean;
}

export const InputArea = React.memo<InputAreaProps>(({ onSubmit, isDisabled = false }) => {
  const [input, setInput] = useState('');

  const handleInput = useCallback((inputChar: string, key: any) => {
    if (isDisabled) return;

    if (key.return) {
      const trimmedInput = input.trim();
      if (trimmedInput) {
        onSubmit(trimmedInput);
        setInput('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }

    if (key.ctrl) {
      return; // Handle Ctrl combinations in parent component
    }

    if (inputChar) {
      setInput(prev => prev + inputChar);
    }
  }, [input, isDisabled, onSubmit]);

  useInput(handleInput);

  return (
    <Box paddingX={1} paddingY={1} flexDirection="row">
      <Text color={COLORS.green}>{'> '}</Text>
      <Box flexGrow={1}>
        <Text>
          {input}
          {!isDisabled && <Text backgroundColor={COLORS.green}> </Text>}
        </Text>
      </Box>
    </Box>
  );
});