import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputProps {
  label?: string;
  placeholder?: string;
  value?: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
}

/**
 * Text input component
 */
export const Input: React.FC<InputProps> = ({
  label,
  placeholder = '',
  value: initialValue = '',
  mask = false,
  onSubmit,
}) => {
  const [value, setValue] = useState(initialValue);

  return (
    <Box>
      {label && (
        <Box marginRight={1}>
          <Text bold>{label}</Text>
        </Box>
      )}
      <TextInput
        placeholder={placeholder}
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        mask={mask ? '*' : undefined}
      />
    </Box>
  );
};

export default Input;