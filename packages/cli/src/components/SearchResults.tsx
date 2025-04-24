import React from 'react';
import { Box, Text } from 'ink';

interface SearchResult {
  id: string;
  title?: string;
  excerpt?: string;
  score: number;
  type: string;
  tags?: string[];
  createdAt: string;
}

interface SearchResultsProps {
  results: SearchResult[];
  query: string;
}

/**
 * Component to display search results
 */
export const SearchResults: React.FC<SearchResultsProps> = ({ results, query }) => {
  if (results.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No results found for query: "{query}"</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Search Results for: "{query}"</Text>
      </Box>
      <Text>Found {results.length} results.</Text>

      <Box flexDirection="column" marginTop={1}>
        {results.map((result, index) => (
          <Box key={result.id} flexDirection="column" marginBottom={1} borderStyle="round" borderColor="gray" padding={1}>
            <Box>
              <Text bold color="blue">Result {index + 1}</Text>
              <Text color="gray"> (Score: {(typeof result.score === 'number' ? result.score : 0).toFixed(2)})</Text>
            </Box>
            
            <Box>
              <Text bold>ID: </Text>
              <Text>{result.id}</Text>
            </Box>
            
            <Box>
              <Text bold>Type: </Text>
              <Text>{result.type}</Text>
            </Box>
            
            {result.title && (
              <Box>
                <Text bold>Title: </Text>
                <Text>{result.title}</Text>
              </Box>
            )}
            
            {result.tags && result.tags.length > 0 && (
              <Box>
                <Text bold>Tags: </Text>
                <Text>{result.tags.join(', ')}</Text>
              </Box>
            )}
            
            <Box>
              <Text bold>Created: </Text>
              <Text>{new Date(result.createdAt).toLocaleString()}</Text>
            </Box>
            
            {result.excerpt && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Excerpt:</Text>
                <Text>{result.excerpt}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default SearchResults;