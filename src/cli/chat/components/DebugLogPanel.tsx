import React, { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';

interface DebugLogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
}

interface DebugLogPanelProps {
  logs: DebugLogEntry[];
  maxHeight?: number;
}

export const DebugLogPanel: React.FC<DebugLogPanelProps> = ({ logs, maxHeight = 20 }) => {
  const scrollOffset = useRef(0);
  
  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    scrollOffset.current = Math.max(0, logs.length - maxHeight);
  }, [logs.length, maxHeight]);

  const visibleLogs = logs.slice(-maxHeight);
  
  const getLevelColor = (level: DebugLogEntry['level']) => {
    switch (level) {
      case 'debug': return 'gray';
      case 'info': return 'blue';
      case 'warn': return 'yellow';
      case 'error': return 'red';
      default: return 'white';
    }
  };
  
  const formatTimestamp = (date: Date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  };

  return (
    <Box 
      flexDirection="column" 
      borderStyle="single" 
      borderColor="gray"
      paddingLeft={1}
      paddingRight={1}
    >
      <Box marginBottom={1}>
        <Text bold color="yellow">Debug Logs (Ctrl+D to toggle)</Text>
      </Box>
      
      {visibleLogs.length === 0 ? (
        <Text color="gray">No debug logs yet...</Text>
      ) : (
        <Box flexDirection="column">
          {visibleLogs.map((log, idx) => (
            <Box key={idx} marginBottom={0}>
              <Text color="gray">[{formatTimestamp(log.timestamp)}]</Text>
              <Text color={getLevelColor(log.level)}> {log.level.toUpperCase().padEnd(5)} </Text>
              {log.source && <Text color="cyan">[{log.source}] </Text>}
              <Text color="white">{log.message}</Text>
            </Box>
          ))}
        </Box>
      )}
      
      {logs.length > maxHeight && (
        <Box marginTop={1}>
          <Text color="gray" italic>
            Showing last {maxHeight} of {logs.length} logs
          </Text>
        </Box>
      )}
    </Box>
  );
};

export type { DebugLogEntry };