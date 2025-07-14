import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { IndexingStatus } from '../state/types.js';
import { COLORS } from '../constants.js';

interface BottomStatusBarProps {
  indexingStatus: IndexingStatus;
}

export const BottomStatusBar = React.memo<BottomStatusBarProps>(({ indexingStatus }) => {
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (indexingStatus.isIndexing) {
      const timer = setInterval(() => {
        setFrame(prev => (prev + 1) % spinnerFrames.length);
      }, 80);
      return () => clearInterval(timer);
    }
  }, [indexingStatus.isIndexing, spinnerFrames.length]);

  const statusContent = useMemo(() => {
    if (!indexingStatus.running) {
      return null;
    }

    if (indexingStatus.isIndexing) {
      return (
        <Box>
          <Text color={COLORS.yellow}>{spinnerFrames[frame]} </Text>
          <Text>Indexing in progress...</Text>
        </Box>
      );
    }

    const lastIndexDate = new Date(indexingStatus.lastIndexTime);
    const now = new Date();
    const diffMs = now.getTime() - lastIndexDate.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    
    let lastIndexText = 'Never indexed';
    if (indexingStatus.lastIndexTime > 0) {
      if (diffMinutes < 1) {
        lastIndexText = 'Indexed just now';
      } else if (diffMinutes < 60) {
        lastIndexText = `Indexed ${diffMinutes}m ago`;
      } else {
        const diffHours = Math.floor(diffMinutes / 60);
        lastIndexText = `Indexed ${diffHours}h ago`;
      }
    }

    return (
      <Box>
        <Text color={COLORS.green}>● </Text>
        <Text>Indexing ready - {lastIndexText}</Text>
      </Box>
    );
  }, [indexingStatus, frame, spinnerFrames]);

  if (!statusContent) {
    return null;
  }

  return (
    <Box 
      borderStyle="single" 
      borderColor={COLORS.gray}
      paddingX={1}
    >
      {statusContent}
    </Box>
  );
});