import React from 'react';
import { Box, Text } from 'ink';
import { ActivityEvent } from '../state/types.js';
import { COLORS } from '../constants.js';

interface ActivityPanelProps {
  activities: ActivityEvent[];
  maxItems?: number;
}

export const ActivityPanel = React.memo<ActivityPanelProps>(({ activities, maxItems = 20 }) => {
  // Show most recent activities first, limited to maxItems
  const recentActivities = activities.slice(-maxItems).reverse();

  const formatTime = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${Math.floor(diffMins / 60)}h ago`;
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color={COLORS.dome}>
        Activity Monitor
      </Text>
      <Text color={COLORS.gray}>─────────────────</Text>

      {recentActivities.length === 0 ? (
        <Box marginTop={1}>
          <Text color={COLORS.gray} italic>
            No activity yet
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {recentActivities.map(activity => (
            <Box key={activity.id} marginBottom={0}>
              <Box width={3}>
                <Text color={activity.type === 'tool' ? COLORS.tool : COLORS.document}>
                  {activity.type === 'tool' ? '▸' : '◆'}
                </Text>
              </Box>
              <Box flexGrow={1} marginRight={1}>
                <Text wrap="truncate-end">{activity.name}</Text>
              </Box>
              <Text color={COLORS.gray} dimColor>
                {formatTime(activity.timestamp)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1} paddingTop={1} borderStyle="single" borderTop borderColor={COLORS.gray}>
        <Text color={COLORS.gray} dimColor>
          {activities.length} total • Ctrl+A toggle
        </Text>
      </Box>
    </Box>
  );
});
