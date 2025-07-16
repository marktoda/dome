import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { COLORS } from '../constants.js';

interface InputAreaProps {
  onSubmit: (input: string) => void;
  isDisabled?: boolean;
}

export const InputArea = React.memo<InputAreaProps>(({ onSubmit, isDisabled = false }) => {
  const [value, setValue] = useState('');

  return (
    <Box paddingX={1} paddingY={1} flexDirection="row">
      <Text color={COLORS.green}>{'> '}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(val: string) => {
          const trimmed = val.trim();
          if (trimmed) {
            onSubmit(trimmed);
          }
          setValue('');
        }}
        focus={!isDisabled}
      />
    </Box>
  );
});
