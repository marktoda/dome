import { describe, it, expect } from 'vitest';
import { TextPreprocessor } from '../src/services/preprocessor';

describe('TextPreprocessor', () => {
  it('normalizes text by trimming and removing excess whitespace', () => {
    const p = new TextPreprocessor();
    const input = ' Hello   world!!!\n\nHow are   you?  ';
    const expected = 'Hello world!!! How are you?';
    expect(p.normalize(input)).toBe(expected);
  });

  it('chunks long text with overlap', () => {
    const p = new TextPreprocessor({ maxChunkSize: 10, overlapSize: 2, minChunkSize: 3 });
    const chunks = p.chunk('abcdefghijklmnopqrstuvwxyz');
    expect(chunks).toEqual(['abcdefghij', 'ijklmnopqr', 'qrstuvwxyz']);
  });

  it('processes text using normalize and chunk', () => {
    const p = new TextPreprocessor({ maxChunkSize: 10, overlapSize: 2, minChunkSize: 3 });
    const result = p.process('  abcdefghijklmnopqrstuvwxyz  ');
    expect(result).toEqual(['abcdefghij', 'ijklmnopqr', 'qrstuvwxyz']);
  });
});
