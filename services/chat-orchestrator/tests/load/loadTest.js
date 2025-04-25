/**
 * Load testing script for Chat RAG Graph implementation
 * 
 * This script simulates production traffic to ensure the system can handle the expected load.
 * It uses k6 (https://k6.io/) for load testing.
 * 
 * Usage:
 * 1. Install k6: https://k6.io/docs/getting-started/installation/
 * 2. Run the test: k6 run loadTest.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { SharedArray } from 'k6/data';

// Custom metrics
const errorRate = new Rate('error_rate');
const successRate = new Rate('success_rate');
const ttftTrend = new Trend('time_to_first_token');
const totalTimeTrend = new Trend('total_response_time');
const tokenRateTrend = new Trend('tokens_per_second');
const requestCounter = new Counter('requests');
const tokenCounter = new Counter('tokens');

// Test configuration
export const options = {
  // Stages for ramping up/down load
  stages: [
    { duration: '1m', target: 10 }, // Ramp up to 10 users over 1 minute
    { duration: '3m', target: 10 }, // Stay at 10 users for 3 minutes
    { duration: '1m', target: 20 }, // Ramp up to 20 users over 1 minute
    { duration: '3m', target: 20 }, // Stay at 20 users for 3 minutes
    { duration: '1m', target: 50 }, // Ramp up to 50 users over 1 minute
    { duration: '3m', target: 50 }, // Stay at 50 users for 3 minutes
    { duration: '1m', target: 0 },  // Ramp down to 0 users over 1 minute
  ],
  
  // Thresholds for success criteria
  thresholds: {
    'error_rate': ['rate<0.01'], // Error rate should be less than 1%
    'success_rate': ['rate>0.99'], // Success rate should be greater than 99%
    'time_to_first_token': ['p95<1000'], // 95% of requests should have TTFT < 1000ms
    'total_response_time': ['p95<5000'], // 95% of requests should complete in < 5000ms
    'tokens_per_second': ['p95>10'], // 95% of requests should have token rate > 10 tokens/sec
  },
};

// Sample user IDs
const userIds = new SharedArray('userIds', function() {
  return Array.from({ length: 100 }, () => `user-${randomString(8)}`);
});

// Sample queries
const queries = new SharedArray('queries', function() {
  return [
    "What is the capital of France?",
    "How do I implement a binary search tree in JavaScript?",
    "Explain the difference between REST and GraphQL.",
    "What are the best practices for securing a Node.js application?",
    "How does the Chat RAG Graph implementation work?",
    "What is the difference between a state machine and a traditional linear flow?",
    "How can I optimize token usage in LLM applications?",
    "What are the key components of a RAG system?",
    "Explain the concept of dynamic widening in search.",
    "How do you handle ambiguous queries in a conversational AI system?",
    "What are the best practices for streaming responses from an LLM?",
    "How can I implement checkpointing in a stateful application?",
    "What is the role of a tool router in a conversational AI system?",
    "How do you balance precision and recall in a retrieval system?",
    "What are the key metrics to monitor in a production LLM application?",
    "How can I implement fallback mechanisms for LLM errors?",
    "What is the difference between fine-tuning and prompt engineering?",
    "How do you handle context limitations in LLM applications?",
    "What are the best practices for logging in a distributed system?",
    "How can I implement a gradual rollout strategy for a new feature?",
  ];
});

// Sample conversation histories
const conversationHistories = new SharedArray('conversationHistories', function() {
  return [
    [], // No history
    [
      { role: 'user', content: 'Hello, how are you?' },
      { role: 'assistant', content: "I'm doing well, thank you for asking! How can I help you today?" },
    ],
    [
      { role: 'user', content: 'What is machine learning?' },
      { role: 'assistant', content: "Machine learning is a subset of artificial intelligence that focuses on building systems that learn from data. Instead of being explicitly programmed to perform a task, these systems are trained on large datasets and learn to recognize patterns and make decisions with minimal human intervention." },
      { role: 'user', content: 'Can you give me some examples?' },
    ],
    [
      { role: 'user', content: 'How do I bake a chocolate cake?' },
      { role: 'assistant', content: "To bake a chocolate cake, you'll need ingredients like flour, sugar, cocoa powder, eggs, milk, and butter. Preheat your oven to 350°F (175°C), mix the dry ingredients, add the wet ingredients, pour into a greased pan, and bake for about 30-35 minutes." },
      { role: 'user', content: 'What about frosting?' },
      { role: 'assistant', content: "For chocolate frosting, you can mix softened butter with powdered sugar, cocoa powder, vanilla extract, and a little milk until smooth and creamy. Wait for the cake to cool completely before frosting it." },
      { role: 'user', content: 'How long does it take to make the whole cake?' },
    ],
  ];
});

/**
 * Default function that is executed for each virtual user
 */
export default function() {
  // Select a random user ID
  const userId = userIds[randomIntBetween(0, userIds.length - 1)];
  
  // Select a random query
  const query = queries[randomIntBetween(0, queries.length - 1)];
  
  // Select a random conversation history
  const history = conversationHistories[randomIntBetween(0, conversationHistories.length - 1)];
  
  // Create messages array with history and new query
  const messages = [
    ...history,
    { role: 'user', content: query },
  ];
  
  // Prepare request payload
  const payload = JSON.stringify({
    initialState: {
      userId,
      messages,
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
        temperature: 0.7,
      },
    },
  });
  
  // Set request headers
  const headers = {
    'Content-Type': 'application/json',
    'x-user-id': userId,
  };
  
  // Track request start time
  const startTime = new Date();
  
  // Send request
  const response = http.post('http://localhost:8787/chat', payload, { headers });
  
  // Increment request counter
  requestCounter.add(1);
  
  // Check if request was successful
  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response has content': (r) => r.body.length > 0,
  });
  
  // Update success/error rates
  successRate.add(success);
  errorRate.add(!success);
  
  // Process streaming response
  if (success) {
    // Parse response body
    let responseText = '';
    let firstTokenTime = null;
    let tokenCount = 0;
    
    // Simulate processing an SSE stream
    // In a real test, you would use WebSocket or SSE client
    const lines = response.body.split('\n\n');
    for (const line of lines) {
      if (line.startsWith('event: token')) {
        const data = JSON.parse(line.replace('event: token\ndata: ', ''));
        responseText += data.token;
        tokenCount++;
        
        // Record time to first token
        if (firstTokenTime === null) {
          firstTokenTime = new Date();
          ttftTrend.add(firstTokenTime - startTime);
        }
      }
    }
    
    // Record total response time
    const endTime = new Date();
    totalTimeTrend.add(endTime - startTime);
    
    // Record token rate (tokens per second)
    const durationSeconds = (endTime - startTime) / 1000;
    if (durationSeconds > 0) {
      tokenRateTrend.add(tokenCount / durationSeconds);
    }
    
    // Add to token counter
    tokenCounter.add(tokenCount);
  }
  
  // Sleep between requests to simulate real user behavior
  sleep(randomIntBetween(1, 5));
}

/**
 * Setup function that runs once per VU
 */
export function setup() {
  console.log('Starting load test for Chat RAG Graph implementation');
  
  // Verify that the service is available
  const response = http.get('http://localhost:8787/health');
  if (response.status !== 200) {
    throw new Error(`Service is not available: ${response.status}`);
  }
  
  console.log('Service is available, proceeding with load test');
}

/**
 * Teardown function that runs at the end of the test
 */
export function teardown() {
  console.log('Load test completed');
}