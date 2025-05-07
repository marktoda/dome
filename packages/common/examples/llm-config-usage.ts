/**
 * Example: LLM Configuration System Usage
 *
 * This example demonstrates how to use the LLM configuration system
 * in a service. It shows:
 *
 * 1. How to initialize the system
 * 2. How to get model configurations
 * 3. How to calculate token limits
 * 4. How to use the configuration in API calls
 */

import {
  configureLlmSystem,
  getModelConfig,
  getDefaultModel,
  getAllModels,
  calculateContextLimits,
  calculateTokenLimits,
  countTokens,
  countMessagesTokens,
  LlmEnvironment,
  BaseModelConfig,
  ModelProvider,
} from '../src/ai';

/**
 * Example environment with LLM configuration
 */
const exampleEnv: LlmEnvironment = {
  OPENAI_API_KEY: 'sk-example-key',
  ANTHROPIC_API_KEY: 'sk-example-anthropic-key',
  DEFAULT_MODEL_ID: 'gpt-4-turbo',
  ENVIRONMENT: 'development',
};

/**
 * Initialize and configure the LLM system
 */
function initializeService(env: LlmEnvironment) {
  // Configure the LLM system with environment variables
  configureLlmSystem(env);

  console.log('LLM service initialized with default model:', getDefaultModel().name);
}

/**
 * Example of getting model configurations
 */
function modelConfigExamples() {
  // Get the default model configuration
  const defaultModel = getDefaultModel();
  console.log('Default model:', defaultModel.name);

  // Get a specific model by key
  const gpt4 = getModelConfig('GPT_4');
  console.log('GPT-4 context window:', gpt4.maxContextTokens);

  // Get a specific model by ID
  const claude = getModelConfig('claude-3-opus-20240229');
  console.log('Claude 3 Opus capabilities:', claude.capabilities);

  // Get all production-ready models
  const prodModels = getAllModels(true);
  console.log(
    'Production-ready models:',
    prodModels.map(m => m.name),
  );

  // Check if a model supports specific capabilities
  const modelForStructuredOutput = getModelConfig('gpt-4-turbo');
  if (modelForStructuredOutput.capabilities.structuredOutput) {
    console.log(`${modelForStructuredOutput.name} supports structured output`);
  }
}

/**
 * Example of token allocation and counting
 */
function tokenAllocationExamples() {
  // Calculate context limits for a model
  const contextLimits = calculateContextLimits('gpt-4');
  console.log('GPT-4 context limits:', contextLimits);

  // Count tokens in text
  const text = 'This is an example text for token counting.';
  const tokenCount = countTokens(text, 'gpt-4');
  console.log(`Text "${text}" has ${tokenCount} tokens`);

  // Count tokens in a messages array
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello, how can you help me with my project?' },
  ];
  const messagesTokens = countMessagesTokens(messages, 'gpt-4');
  console.log(`Messages array has ${messagesTokens} tokens`);

  // Calculate dynamic token limits based on input
  const inputTokens = 1000;
  const limits = calculateTokenLimits('gpt-4', inputTokens);
  console.log(`With ${inputTokens} input tokens, max response tokens:`, limits.maxResponseTokens);
}

/**
 * Example of using the configuration for an LLM API call
 */
async function makeLlmApiCall(prompt: string, modelId?: string) {
  // Get model configuration
  const modelConfig = getModelConfig(modelId);

  // Count tokens in the prompt
  const promptTokens = countTokens(prompt, modelConfig.id);

  // Calculate maximum response tokens
  const { maxResponseTokens } = calculateTokenLimits(modelConfig, promptTokens);

  console.log(`Using model: ${modelConfig.name}`);
  console.log(`Prompt tokens: ${promptTokens}`);
  console.log(`Max response tokens: ${maxResponseTokens}`);

  // In a real implementation, you would make the API call here:
  // return someApiClient.createCompletion({
  //   model: modelConfig.id,
  //   prompt,
  //   max_tokens: maxResponseTokens,
  //   temperature: modelConfig.defaultTemperature,
  // });

  // For this example, we just return a mock response
  return {
    model: modelConfig.id,
    prompt,
    max_tokens: maxResponseTokens,
    temperature: modelConfig.defaultTemperature,
    response: 'This is a mock response from the LLM API.',
  };
}

/**
 * Example of using the configuration for chat completions
 */
async function makeChatCompletionCall(
  messages: Array<{ role: string; content: string }>,
  modelId?: string,
) {
  // Get model configuration
  const modelConfig = getModelConfig(modelId);

  // Check if model supports streaming (for example)
  const streamingEnabled = modelConfig.capabilities.streaming;

  // Count tokens in the messages
  const messagesTokens = countMessagesTokens(messages, modelConfig.id);

  // Calculate maximum response tokens
  const { maxResponseTokens } = calculateTokenLimits(modelConfig, messagesTokens);

  console.log(`Using model: ${modelConfig.name}`);
  console.log(`Messages tokens: ${messagesTokens}`);
  console.log(`Max response tokens: ${maxResponseTokens}`);
  console.log(`Streaming enabled: ${streamingEnabled}`);

  // In a real implementation, you would make the API call here:
  // return someApiClient.createChatCompletion({
  //   model: modelConfig.id,
  //   messages,
  //   max_tokens: maxResponseTokens,
  //   temperature: modelConfig.defaultTemperature,
  //   stream: streamingEnabled,
  // });

  // For this example, we just return a mock response
  return {
    model: modelConfig.id,
    messages,
    max_tokens: maxResponseTokens,
    temperature: modelConfig.defaultTemperature,
    stream: streamingEnabled,
    response: 'This is a mock response from the chat completion API.',
  };
}

/**
 * Main function to run all examples
 */
async function runExamples() {
  // Initialize the service
  initializeService(exampleEnv);

  // Run the examples
  console.log('\n=== Model Configuration Examples ===');
  modelConfigExamples();

  console.log('\n=== Token Allocation Examples ===');
  tokenAllocationExamples();

  console.log('\n=== LLM API Call Example ===');
  const apiResponse = await makeLlmApiCall(
    'Explain the concept of context windows in LLMs.',
    'GPT_4_TURBO',
  );
  console.log('API response:', apiResponse);

  console.log('\n=== Chat Completion Example ===');
  const chatResponse = await makeChatCompletionCall([
    { role: 'system', content: 'You are a helpful AI assistant.' },
    { role: 'user', content: 'How can I implement a robust error handling system?' },
  ]);
  console.log('Chat response:', chatResponse);
}

// runExamples().catch(console.error);

// Export example functions for potential reuse
export {
  initializeService,
  modelConfigExamples,
  tokenAllocationExamples,
  makeLlmApiCall,
  makeChatCompletionCall,
  runExamples,
};
