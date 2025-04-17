import React from 'react';
import { Text, Box } from 'ink';
import Spinner from 'ink-spinner';

interface LoadingProps {
  text?: string;
}

/**
 * Loading component with spinner
 */
export const Loading: React.FC<LoadingProps> = ({ text = 'Loading...' }) => {
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Box marginLeft={1}>
        <Text>{text}</Text>
      </Box>
    </Box>
  );
};

export default Loading;