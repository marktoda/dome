import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { IndexingStatus } from '../state/types.js';
import { COLORS } from '../constants.js';

interface BottomStatusBarProps {
  indexingStatus: IndexingStatus;
}

export const BottomStatusBar = React.memo<BottomStatusBarProps>(({ indexingStatus }) => {
  if (!indexingStatus.running) {
    return null;
  }

  let statusContent: React.ReactNode;

  if (indexingStatus.isIndexing) {
    statusContent = (
      <Box>
        <Text color={COLORS.yellow}>
          <Spinner type="dots" />{' '}
        </Text>
        <Text>Indexing in progress...</Text>
      </Box>
    );
  } else {
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

    statusContent = (
      <Box>
        <Text color={COLORS.green}>● </Text>
        <Text>Indexing ready - {lastIndexText}</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" borderColor={COLORS.gray} paddingX={1}>
      {statusContent}
    </Box>
  );
});
