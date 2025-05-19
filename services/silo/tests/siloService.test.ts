import { describe, it, expect, vi } from 'vitest';
import { SiloService } from '../src/services/siloService';
import type { MetadataService } from '../src/services/metadataService';

// Helper to create service with a mocked metadata service
function createService() {
  const metadataService = {
    getMetadataByUserId: vi.fn(),
  } as unknown as MetadataService;
  const service = new SiloService(metadataService);
  return { service, metadataService };
}

describe('SiloService static helpers', () => {
  it('identifies public content', () => {
    expect(SiloService.isPublicContent(SiloService.PUBLIC_USER_ID)).toBe(true);
    expect(SiloService.isPublicContent(null)).toBe(true);
    expect(SiloService.isPublicContent('')).toBe(true);
    expect(SiloService.isPublicContent('user')).toBe(false);
  });

  it('normalizes user ids', () => {
    expect(SiloService.normalizeUserId(null)).toBe(SiloService.PUBLIC_USER_ID);
    expect(SiloService.normalizeUserId('')).toBe(SiloService.PUBLIC_USER_ID);
    expect(SiloService.normalizeUserId('user')).toBe('user');
  });
});

describe('SiloService.fetchContentForUser', () => {
  it('combines and sorts user and public content', async () => {
    const { service, metadataService } = createService();

    const userContent = [
      { id: 'a', userId: 'user', createdAt: 2 },
      { id: 'b', userId: 'user', createdAt: 1 },
    ];
    const publicContent = [
      { id: 'c', userId: SiloService.PUBLIC_USER_ID, createdAt: 3 },
    ];

    metadataService.getMetadataByUserId
      .mockResolvedValueOnce(userContent)
      .mockResolvedValueOnce(publicContent);

    const result = await service.fetchContentForUser('user', undefined, 10, 0);

    expect(metadataService.getMetadataByUserId).toHaveBeenCalledTimes(2);
    // Expect combined results sorted by createdAt desc
    expect(result.map(r => r.id)).toEqual(['c', 'a', 'b']);
  });
});
