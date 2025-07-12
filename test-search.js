// Simple test to verify our search implementation works
import { searchNotesTool } from './src/mastra/tools/search-notes-tool.js';

async function testSearch() {
  try {
    console.log('Testing search functionality...');
    
    const result = await searchNotesTool.execute({
      context: {
        query: "test query",
        k: 3
      }
    });
    
    console.log('Search result:', result);
  } catch (error) {
    console.error('Search test failed:', error.message);
  }
}

testSearch();