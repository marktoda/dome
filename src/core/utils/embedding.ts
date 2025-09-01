/**
 * Simple embedding utilities.
 */

import { aiEmbed, aiEmbedBatch } from '../../mastra/services/AIService.js';

export const embedText = aiEmbed;
export const embedChunks = aiEmbedBatch;