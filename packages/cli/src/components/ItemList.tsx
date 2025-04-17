import React from 'react';
import { Box, Text } from 'ink';

interface Note {
  id: string;
  title?: string;
  content: string;
  createdAt: string;
  tags?: string[];
}

interface Task {
  id: string;
  description: string;
  status: string;
  dueDate?: string;
  createdAt: string;
  tags?: string[];
}

type Item = Note | Task;

interface ItemListProps {
  items: Item[];
  type: 'notes' | 'tasks';
  filter?: string;
}

/**
 * Component to display a list of notes or tasks
 */
export const ItemList: React.FC<ItemListProps> = ({ items, type, filter }) => {
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No {type} found{filter ? ` matching filter: "${filter}"` : ''}.</Text>
      </Box>
    );
  }

  const isTask = (item: Item): item is Task => 'status' in item && 'description' in item;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{type.charAt(0).toUpperCase() + type.slice(1)}</Text>
        {filter && <Text color="gray"> (filter: {filter})</Text>}
      </Box>

      <Box flexDirection="column">
        {items.map((item) => (
          <Box 
            key={item.id} 
            flexDirection="column" 
            marginBottom={1} 
            borderStyle="single" 
            borderColor="gray" 
            padding={1}
          >
            <Box>
              <Text bold color="blue">ID: </Text>
              <Text>{item.id}</Text>
            </Box>
            
            {isTask(item) ? (
              // Task-specific fields
              <>
                <Box>
                  <Text bold>Description: </Text>
                  <Text>{item.description}</Text>
                </Box>
                
                <Box>
                  <Text bold>Status: </Text>
                  <Text color={item.status === 'completed' ? 'green' : 'yellow'}>
                    {item.status}
                  </Text>
                </Box>
                
                {item.dueDate && (
                  <Box>
                    <Text bold>Due Date: </Text>
                    <Text>{new Date(item.dueDate).toLocaleString()}</Text>
                  </Box>
                )}
              </>
            ) : (
              // Note-specific fields
              <>
                <Box>
                  <Text bold>Title: </Text>
                  <Text>{item.title || '(No title)'}</Text>
                </Box>
                
                <Box flexDirection="column">
                  <Text bold>Content: </Text>
                  <Text>{item.content.length > 100 
                    ? `${item.content.substring(0, 100)}...` 
                    : item.content}
                  </Text>
                </Box>
              </>
            )}
            
            <Box>
              <Text bold>Created: </Text>
              <Text>{new Date(item.createdAt).toLocaleString()}</Text>
            </Box>
            
            {item.tags && item.tags.length > 0 && (
              <Box>
                <Text bold>Tags: </Text>
                <Text>{item.tags.join(', ')}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default ItemList;