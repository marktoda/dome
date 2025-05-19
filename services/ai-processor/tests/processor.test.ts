import { describe, it, expect } from 'vitest';
import { ContentProcessor } from '../src/utils/processor';
import type { ProcessorServices } from '../src/utils/processor';

const env: any = {};
const services: ProcessorServices = {
  llm: { processContent: async () => ({ title: 't' }) } as any,
  silo: {} as any,
};

describe('ContentProcessor.normalize', () => {
  it('fills defaults when fields missing', () => {
    const cp = new ContentProcessor(env, services);
    const result = (cp as any).normalize({ title: 'Hello' } as any);
    expect(result.title).toBe('Hello');
    expect(result.processingVersion).toBe(2);
    expect(result.modelUsed).toBe('@cf/google/gemma-7b-it-lora');
    expect(result.summary).toBeUndefined();
  });
});
