/**
 * Tests for the LLM Configuration System
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  modelRegistry,
  getModelConfig,
  getDefaultModel,
  getAllModels,
  calculateContextLimits,
  calculateTokenLimits,
  ModelProvider,
  BaseModelConfig,
  configureLlmSystem,
} from '../../src/ai';

describe('LLM Configuration System', () => {
  // Save the original registry state
  const originalModels = modelRegistry.getAll();
  
  // Reset the registry after each test
  afterEach(() => {
    modelRegistry.clear();
    modelRegistry.registerMany(originalModels);
  });
  
  describe('Model Registry', () => {
    it('should provide access to predefined models', () => {
      // Get all models
      const allModels = getAllModels();
      
      // Verify we have models from different providers
      expect(allModels.length).toBeGreaterThan(0);
      
      // Check for specific providers
      const openaiModels = allModels.filter(m => m.provider === ModelProvider.OPENAI);
      const anthropicModels = allModels.filter(m => m.provider === ModelProvider.ANTHROPIC);
      const cloudflareModels = allModels.filter(m => m.provider === ModelProvider.CLOUDFLARE);
      
      expect(openaiModels.length).toBeGreaterThan(0);
      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(cloudflareModels.length).toBeGreaterThan(0);
    });
    
    it('should allow retrieving models by key or ID', () => {
      // Get model by key
      const gpt4ByKey = getModelConfig('GPT_4');
      expect(gpt4ByKey).toBeDefined();
      expect(gpt4ByKey.key).toBe('GPT_4');
      expect(gpt4ByKey.id).toBe('gpt-4');
      
      // Get model by ID
      const gpt4ById = getModelConfig('gpt-4');
      expect(gpt4ById).toBeDefined();
      expect(gpt4ById.key).toBe('GPT_4');
      expect(gpt4ById.id).toBe('gpt-4');
      
      // Keys should be case sensitive
      const wrongKey = getModelConfig('gpt_4');
      // If model not found, should return default model
      expect(wrongKey.key).not.toBe('GPT_4');
    });
    
    it('should have a default model', () => {
      const defaultModel = getDefaultModel();
      expect(defaultModel).toBeDefined();
      expect(defaultModel.key).toBeDefined();
      expect(defaultModel.id).toBeDefined();
    });
    
    it('should allow setting a different default model', () => {
      // Get the original default model
      const originalDefault = getDefaultModel();
      
      // Set a different model as default (using Claude 3 Opus key)
      modelRegistry.setDefaultModel('CLAUDE_3_OPUS');
      
      // Get the new default model
      const newDefault = getDefaultModel();
      
      // Verify the default changed
      expect(newDefault.key).toBe('CLAUDE_3_OPUS');
      expect(newDefault.id).toBe('claude-3-opus-20240229');
      expect(newDefault.key).not.toBe(originalDefault.key);
      
      // Reset to original default
      modelRegistry.setDefaultModel(originalDefault.key);
    });
    
    it('should allow adding custom models', () => {
      // Define a custom model
      const customModel: BaseModelConfig = {
        key: 'CUSTOM_TEST_MODEL',
        id: 'custom-test-model',
        name: 'Custom Test Model',
        provider: ModelProvider.CUSTOM,
        maxContextTokens: 10000,
        defaultMaxTokens: 500,
        defaultTemperature: 0.5,
        capabilities: {
          streaming: true,
          functionCalling: false,
          toolUse: false,
          structuredOutput: false,
          vision: false,
        },
        productionReady: false,
      };
      
      // Register the custom model
      modelRegistry.register(customModel);
      
      // Verify it was added
      const retrieved = getModelConfig('CUSTOM_TEST_MODEL');
      expect(retrieved).toBeDefined();
      expect(retrieved.key).toBe('CUSTOM_TEST_MODEL');
      expect(retrieved.id).toBe('custom-test-model');
    });
  });
  
  describe('Context Allocation', () => {
    it('should calculate token limits based on model context window', () => {
      // Get a model with known context window
      const model = getModelConfig('GPT_4');
      
      // Calculate context limits
      const limits = calculateContextLimits(model);
      
      // Verify limits are calculated
      expect(limits.maxContextTokens).toBe(model.maxContextTokens);
      expect(limits.maxResponseTokens).toBeDefined();
      expect(limits.maxSystemPromptTokens).toBeDefined();
      expect(limits.maxUserMessagesTokens).toBeDefined();
      expect(limits.maxDocumentsTokens).toBeDefined();
      
      // Verify limits add up to total context (with some rounding error)
      const totalAllocated = 
        limits.maxSystemPromptTokens! +
        limits.maxUserMessagesTokens! +
        limits.maxDocumentsTokens! +
        limits.maxResponseTokens;
      
      // Should be slightly less than max due to safety margin
      expect(totalAllocated).toBeLessThan(model.maxContextTokens);
      expect(model.maxContextTokens - totalAllocated).toBeLessThan(150); // Safety margin + rounding
    });
    
    it('should calculate token limits with custom allocation', () => {
      // Get a model
      const model = getModelConfig('GPT_4');
      
      // Custom allocation that prioritizes documents
      const customAllocation = {
        systemPromptPercentage: 0.1,
        userMessagesPercentage: 0.2,
        documentsPercentage: 0.5,    // Higher document allocation
        responsePercentage: 0.2,
      };
      
      // Calculate with custom allocation
      const limits = calculateContextLimits(model, customAllocation);
      
      // Verify custom allocation was applied
      expect(limits.maxDocumentsTokens).toBeGreaterThan(
        limits.maxSystemPromptTokens! + limits.maxUserMessagesTokens!
      );
      
      // Verify percentages match expected values
      expect(limits.maxDocumentsTokens! / model.maxContextTokens).toBeCloseTo(0.5, 1);
    });
    
    it('should calculate response tokens based on remaining context', () => {
      // Get a model
      const model = getModelConfig('GPT_4');
      
      // Calculate response tokens with different input tokens
      const smallInput = 100;
      const largeInput = 7000;
      
      const smallInputLimits = calculateTokenLimits(model, smallInput);
      const largeInputLimits = calculateTokenLimits(model, largeInput);
      
      // Verify response tokens adjust based on input size
      expect(smallInputLimits.maxResponseTokens).toBeGreaterThan(largeInputLimits.maxResponseTokens);
      
      // Verify limits don't exceed default max
      expect(smallInputLimits.maxResponseTokens).toBeLessThanOrEqual(model.defaultMaxTokens);
      
      // Verify large input still has some space for response
      expect(largeInputLimits.maxResponseTokens).toBeGreaterThan(0);
    });
  });
  
  describe('System Configuration', () => {
    it('should configure default model from environment', () => {
      // Mock environment
      const env = {
        DEFAULT_MODEL_ID: 'claude-3-sonnet-20240229',
        ENVIRONMENT: 'test',
      };
      
      // Original default
      const originalDefault = getDefaultModel();
      
      // Configure system with mock env
      configureLlmSystem(env);
      
      // Get new default
      const newDefault = getDefaultModel();
      
      // Verify default was updated
      expect(newDefault.id).toBe('claude-3-sonnet-20240229');
      
      // Reset to original default
      modelRegistry.setDefaultModel(originalDefault.key);
    });
    
    it('should handle invalid model IDs gracefully', () => {
      // Mock environment with invalid model ID
      const env = {
        DEFAULT_MODEL_ID: 'non-existent-model',
        ENVIRONMENT: 'test',
      };
      
      // Original default
      const originalDefault = getDefaultModel();
      
      // Configure system with invalid model ID
      // This should log a warning but not throw
      configureLlmSystem(env);
      
      // Default should not have changed
      const stillDefault = getDefaultModel();
      expect(stillDefault.key).toBe(originalDefault.key);
    });
  });
});