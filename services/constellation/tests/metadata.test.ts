import { describe, it, expect } from 'vitest';
import { toIndexMetadata } from '../src/utils/metadata';
import { VectorMeta } from '@dome/common';

const meta: VectorMeta = {
  userId: 'u1',
  contentId: 'c1',
  category: 'note',
  mimeType: 'text/plain',
  createdAt: 1,
  version: 1,
};

describe('toIndexMetadata', () => {
  it('converts VectorMeta to index metadata shape', () => {
    const res = toIndexMetadata(meta);
    expect(res).toMatchObject(meta);
  });
});
