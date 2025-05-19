import { describe, it, expect } from 'vitest';
import { LlmService } from '../src/services/llmService';
import { BaseContentSchema } from '../src/schemas';

const env: any = { AI: { run: async () => ({ response: '{}' }) } };

// Helper to access private method
function parse(service: LlmService, response: string) {
  return (service as any).parseStructuredResponse(response, BaseContentSchema, 'req');
}

describe('LlmService.parseStructuredResponse', () => {
  it('parses valid JSON inside code fence', () => {
    const service = new LlmService(env);
    const res = parse(service, '```json\n{"title":"t","summary":"s"}\n```');
    expect(res.title).toBe('t');
    expect(res.summary).toBe('s');
  });

  it('throws truncated error for incomplete JSON', () => {
    const service = new LlmService(env);
    const input = '{"title":"t"';
    expect(() => parse(service, input)).toThrowError('suspected truncation');
  });

  it('throws generic error for invalid JSON', () => {
    const service = new LlmService(env);
    expect(() => parse(service, 'not json')).toThrowError('Failed to parse structured response');
  });
});
