/**
 * Simplified AI service using Mastra for all AI operations.
 */

import { z } from 'zod';
import { config } from '../../core/utils/config.js';
import { retry, timeout } from '../../core/utils/errors.js';
import logger from '../../core/utils/logger.js';
import { openai } from '@ai-sdk/openai';
import { generateText, generateObject, embed } from 'ai';

/**
 * Generate text using AI
 */
export async function aiGenerateText(
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}
): Promise<string> {
  try {
    const result = await retry(async () => {
      const response = await timeout(
        generateText({
          model: openai(options.model || config.ai.models.default),
          prompt,
          temperature: options.temperature ?? config.ai.temperature.default,
          maxTokens: options.maxTokens || config.ai.maxTokens,
        }),
        30000
      );
      return response.text;
    });
    
    return result;
  } catch (error) {
    logger.error(`AI text generation failed: ${error}`);
    throw error;
  }
}

/**
 * Generate structured object using AI
 */
export async function aiGenerateObject<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}
): Promise<T> {
  try {
    const result = await retry(async () => {
      const response = await timeout(
        generateObject({
          model: openai(options.model || config.ai.models.default),
          prompt,
          schema,
          temperature: options.temperature ?? config.ai.temperature.default,
          maxTokens: options.maxTokens || config.ai.maxTokens,
        }),
        30000
      );
      return response.object;
    });
    
    return result;
  } catch (error) {
    logger.error(`AI object generation failed: ${error}`);
    throw error;
  }
}

/**
 * Generate embedding for text
 */
export async function aiEmbed(text: string): Promise<number[]> {
  try {
    const result = await embed({
      model: openai.embedding(config.ai.models.embedding),
      value: text,
    });
    return result.embedding;
  } catch (error) {
    logger.error(`Embedding generation failed: ${error}`);
    throw error;
  }
}

/**
 * Generate embeddings for multiple texts
 */
export async function aiEmbedBatch(texts: string[]): Promise<number[][]> {
  try {
    // Process in parallel with batching
    const batchSize = 10;
    const embeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(aiEmbed));
      embeddings.push(...results);
    }
    
    return embeddings;
  } catch (error) {
    logger.error(`Batch embedding failed: ${error}`);
    throw error;
  }
}

/**
 * Summarize text content
 */
export async function aiSummarize(
  content: string,
  maxSentences = 2
): Promise<string> {
  const prompt = `Summarize in ${maxSentences} sentences. Be concise and factual:\n\n${content.slice(0, 3000)}`;
  
  return aiGenerateText(prompt, {
    model: config.ai.models.summarizer,
    temperature: config.ai.temperature.summarizer,
    maxTokens: 180,
  });
}


// Export functions directly - no mastra dependency needed
export const aiService = {
  generateText: aiGenerateText,
  generateObject: aiGenerateObject,
  generateEmbedding: aiEmbed,
  generateEmbeddings: aiEmbedBatch,
  summarize: aiSummarize,
};