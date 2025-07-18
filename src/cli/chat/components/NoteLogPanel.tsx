import React from 'react';
import { Box, Text } from 'ink';

interface NoteLogPanelProps {
  notes: string[];
  selectedIdx: number;
  visibleRows?: number;
}

/**
 * NoteLogPanel renders a scrollable list of note paths that have been
 * accessed by the model (via getNote tool calls).  The list is read-only –
 * selection is handled by the parent component via the `selectedIdx` prop.
 */
export const NoteLogPanel: React.FC<NoteLogPanelProps> = ({
  notes,
  selectedIdx,
  visibleRows = 30,
}) => {
  // Guard against empty list
  if (notes.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={0} justifyContent="flex-end">
        <Box flexDirection="column">
          <Text bold>Note Access Log</Text>
          <Text dimColor italic>
            — no notes accessed —
          </Text>
        </Box>
      </Box>
    );
  }

  // Calculate slice to keep the selected item always visible
  const start = Math.max(0, selectedIdx - Math.floor(visibleRows / 2));
  const end = Math.min(notes.length, start + visibleRows);
  const windowed = notes.slice(start, end);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} justifyContent="flex-end">
      <Box flexDirection="column">
        <Text bold>Note Access Log</Text>
        <Text color="gray">────────────────────</Text>
        {windowed.map((path, idx) => {
          const globalIdx = start + idx;
          const isSelected = globalIdx === selectedIdx;
          const fileName = path.split('/').pop() || path;
          return (
            <Text
              key={globalIdx}
              inverse={isSelected}
              wrap="truncate-end"
              color={isSelected ? 'black' : 'white'}
            >
              {`${fileName}`}
            </Text>
          );
        })}
        <Box marginTop={1}>
          <Text dimColor>
            Ctrl+↑/↓ Navigate • Tab Open
          </Text>
        </Box>
      </Box>
    </Box>
  );
}; 