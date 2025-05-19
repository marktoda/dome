import { describe, it, expect } from 'vitest';
import { sliceIntoBatches } from '../src/utils/batching';

describe('sliceIntoBatches', () => {
  it('returns empty array for empty input', () => {
    expect(sliceIntoBatches([], 3)).toEqual([]);
  });

  it('returns single batch when size exceeds array length', () => {
    expect(sliceIntoBatches([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('splits array into batches of given size', () => {
    const result = sliceIntoBatches([1, 2, 3, 4, 5, 6, 7], 3);
    expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });
});
