import { createHash } from 'crypto';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';

// ---------------------------------------------------------------------------
// Embedding helpers with SHA-1 based in-memory cache.
// The cache dramatically reduces token usage when re-indexing unchanged chunks
// within the same process. It can be swapped for a persistent store later.
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = 'text-embedding-3-small';

// cacheKey -> vector
const cache = new Map<string, number[]>();

/**
 * Embed an array of text chunks, using the cache whenever possible.
 * The returned vectors preserve the order of the input array.
 */
export async function embedChunks(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const uncachedTexts: string[] = [];
  const uncachedIndexes: number[] = [];
  const vectors: number[][] = new Array(texts.length);

  texts.forEach((text, idx) => {
    const key = sha1(text);
    const cached = cache.get(key);
    if (cached) {
      vectors[idx] = cached;
    } else {
      uncachedTexts.push(text);
      uncachedIndexes.push(idx);
    }
  });

  if (uncachedTexts.length) {
    const { embeddings } = await embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: uncachedTexts,
    });

    embeddings.forEach((vector, i) => {
      const originalIdx = uncachedIndexes[i];
      vectors[originalIdx] = vector;
      cache.set(sha1(uncachedTexts[i]), vector);
    });
  }

  return vectors;
}

/**
 * Embed a single text snippet with cache.
 */
export async function embedText(text: string): Promise<number[]> {
  const key = sha1(text);
  const cached = cache.get(key);
  if (cached) return cached;

  const { embeddings } = await embedMany({
    model: openai.embedding(EMBEDDING_MODEL),
    values: [text],
  });
  cache.set(key, embeddings[0]);
  return embeddings[0];
}

function sha1(data: string): string {
  return createHash('sha1').update(data).digest('hex');
} 