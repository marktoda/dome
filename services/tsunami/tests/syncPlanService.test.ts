import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncPlanService } from '../src/services/syncPlanService';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  createServiceMetrics: vi.fn().mockReturnValue({
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  }),
}));

vi.mock('../src/services/ignoreFileService', () => ({
  IgnoreFileService: vi.fn().mockImplementation(() => ({
    shouldIgnore: vi.fn().mockReturnValue(false),
    getIgnorePatterns: vi.fn().mockReturnValue(['*.log', 'node_modules/**']),
  })),
}));

describe('SyncPlanService', () => {
  let syncPlanService: SyncPlanService;
  let mockIgnoreService: any;

  beforeEach(() => {
    mockIgnoreService = {
      shouldIgnore: vi.fn().mockReturnValue(false),
      getIgnorePatterns: vi.fn().mockReturnValue(['*.log', 'node_modules/**']),
    };

    syncPlanService = new SyncPlanService(mockIgnoreService);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create SyncPlanService instance', () => {
      expect(syncPlanService).toBeInstanceOf(SyncPlanService);
    });
  });

  describe('createSyncPlan', () => {
    it('should create sync plan for new files', () => {
      const remoteFiles = [
        { path: 'src/index.ts', lastModified: new Date('2023-01-01'), hash: 'hash1' },
        { path: 'README.md', lastModified: new Date('2023-01-02'), hash: 'hash2' },
      ];

      const localFiles = []; // No local files

      const syncPlan = syncPlanService.createSyncPlan(remoteFiles, localFiles);

      expect(syncPlan.toAdd).toHaveLength(2);
      expect(syncPlan.toUpdate).toHaveLength(0);
      expect(syncPlan.toDelete).toHaveLength(0);
      expect(syncPlan.toAdd[0]).toMatchObject({
        path: 'src/index.ts',
        action: 'add',
      });
    });

    it('should create sync plan for updated files', () => {
      const remoteFiles = [
        { path: 'src/index.ts', lastModified: new Date('2023-01-02'), hash: 'newhash1' },
      ];

      const localFiles = [
        { path: 'src/index.ts', lastModified: new Date('2023-01-01'), hash: 'oldhash1' },
      ];

      const syncPlan = syncPlanService.createSyncPlan(remoteFiles, localFiles);

      expect(syncPlan.toAdd).toHaveLength(0);
      expect(syncPlan.toUpdate).toHaveLength(1);
      expect(syncPlan.toDelete).toHaveLength(0);
      expect(syncPlan.toUpdate[0]).toMatchObject({
        path: 'src/index.ts',
        action: 'update',
      });
    });

    it('should create sync plan for deleted files', () => {
      const remoteFiles = []; // No remote files

      const localFiles = [
        { path: 'old-file.ts', lastModified: new Date('2023-01-01'), hash: 'hash1' },
      ];

      const syncPlan = syncPlanService.createSyncPlan(remoteFiles, localFiles);

      expect(syncPlan.toAdd).toHaveLength(0);
      expect(syncPlan.toUpdate).toHaveLength(0);
      expect(syncPlan.toDelete).toHaveLength(1);
      expect(syncPlan.toDelete[0]).toMatchObject({
        path: 'old-file.ts',
        action: 'delete',
      });
    });

    it('should skip ignored files', () => {
      mockIgnoreService.shouldIgnore.mockImplementation((path: string) => 
        path.endsWith('.log') || path.includes('node_modules')
      );

      const remoteFiles = [
        { path: 'src/index.ts', lastModified: new Date('2023-01-01'), hash: 'hash1' },
        { path: 'debug.log', lastModified: new Date('2023-01-01'), hash: 'hash2' },
        { path: 'node_modules/lib.js', lastModified: new Date('2023-01-01'), hash: 'hash3' },
      ];

      const localFiles = [];

      const syncPlan = syncPlanService.createSyncPlan(remoteFiles, localFiles);

      expect(syncPlan.toAdd).toHaveLength(1);
      expect(syncPlan.toAdd[0].path).toBe('src/index.ts');
    });

    it('should handle identical files (no changes)', () => {
      const remoteFiles = [
        { path: 'src/index.ts', lastModified: new Date('2023-01-01'), hash: 'hash1' },
      ];

      const localFiles = [
        { path: 'src/index.ts', lastModified: new Date('2023-01-01'), hash: 'hash1' },
      ];

      const syncPlan = syncPlanService.createSyncPlan(remoteFiles, localFiles);

      expect(syncPlan.toAdd).toHaveLength(0);
      expect(syncPlan.toUpdate).toHaveLength(0);
      expect(syncPlan.toDelete).toHaveLength(0);
    });
  });

  describe('calculateSyncStats', () => {
    it('should calculate sync statistics', () => {
      const remoteFiles = [
        { path: 'file1.ts', size: 1000 },
        { path: 'file2.ts', size: 2000 },
        { path: 'file3.ts', size: 500 },
      ];

      const localFiles = [
        { path: 'file1.ts', size: 1000 }, // Same
        { path: 'file2.ts', size: 1500 }, // Different
        { path: 'old-file.ts', size: 800 }, // To be deleted
      ];

      const stats = syncPlanService.calculateSyncStats(remoteFiles, localFiles);

      expect(stats.totalRemoteFiles).toBe(3);
      expect(stats.totalLocalFiles).toBe(3);
      expect(stats.filesToAdd).toBe(1); // file3.ts
      expect(stats.filesToUpdate).toBe(1); // file2.ts
      expect(stats.filesToDelete).toBe(1); // old-file.ts
      expect(stats.totalSizeToSync).toBe(2500); // file3.ts (500) + file2.ts (2000)
    });

    it('should handle empty file lists', () => {
      const stats = syncPlanService.calculateSyncStats([], []);

      expect(stats.totalRemoteFiles).toBe(0);
      expect(stats.totalLocalFiles).toBe(0);
      expect(stats.filesToAdd).toBe(0);
      expect(stats.filesToUpdate).toBe(0);
      expect(stats.filesToDelete).toBe(0);
      expect(stats.totalSizeToSync).toBe(0);
    });

    it('should exclude ignored files from stats', () => {
      mockIgnoreService.shouldIgnore.mockImplementation((path: string) => 
        path.endsWith('.log')
      );

      const remoteFiles = [
        { path: 'src/index.ts', size: 1000 },
        { path: 'debug.log', size: 500 }, // Should be ignored
      ];

      const stats = syncPlanService.calculateSyncStats(remoteFiles, []);

      expect(stats.totalRemoteFiles).toBe(1); // Only counting non-ignored files
      expect(stats.filesToAdd).toBe(1);
      expect(stats.totalSizeToSync).toBe(1000);
    });
  });

  describe('optimizeSyncPlan', () => {
    it('should prioritize small files for faster sync', () => {
      const syncPlan = {
        toAdd: [
          { path: 'large-file.ts', size: 10000, priority: 'normal' },
          { path: 'small-file.ts', size: 100, priority: 'normal' },
          { path: 'medium-file.ts', size: 1000, priority: 'normal' },
        ],
        toUpdate: [],
        toDelete: [],
      };

      const optimizedPlan = syncPlanService.optimizeSyncPlan(syncPlan);

      expect(optimizedPlan.toAdd[0].path).toBe('small-file.ts');
      expect(optimizedPlan.toAdd[1].path).toBe('medium-file.ts');
      expect(optimizedPlan.toAdd[2].path).toBe('large-file.ts');
    });

    it('should respect priority levels', () => {
      const syncPlan = {
        toAdd: [
          { path: 'normal-file.ts', size: 100, priority: 'normal' },
          { path: 'high-priority.ts', size: 10000, priority: 'high' },
          { path: 'low-priority.ts', size: 50, priority: 'low' },
        ],
        toUpdate: [],
        toDelete: [],
      };

      const optimizedPlan = syncPlanService.optimizeSyncPlan(syncPlan);

      expect(optimizedPlan.toAdd[0].path).toBe('high-priority.ts');
      expect(optimizedPlan.toAdd[1].path).toBe('normal-file.ts');
      expect(optimizedPlan.toAdd[2].path).toBe('low-priority.ts');
    });

    it('should batch similar operations', () => {
      const syncPlan = {
        toAdd: [
          { path: 'src/component1.ts', type: 'typescript' },
          { path: 'docs/readme.md', type: 'markdown' },
          { path: 'src/component2.ts', type: 'typescript' },
        ],
        toUpdate: [],
        toDelete: [],
      };

      const optimizedPlan = syncPlanService.optimizeSyncPlan(syncPlan);

      // TypeScript files should be grouped together
      const typescriptFiles = optimizedPlan.toAdd.filter(f => f.type === 'typescript');
      expect(typescriptFiles).toHaveLength(2);
    });
  });

  describe('validateSyncPlan', () => {
    it('should validate a correct sync plan', () => {
      const syncPlan = {
        toAdd: [
          { path: 'new-file.ts', action: 'add' },
        ],
        toUpdate: [
          { path: 'existing-file.ts', action: 'update' },
        ],
        toDelete: [
          { path: 'old-file.ts', action: 'delete' },
        ],
      };

      const isValid = syncPlanService.validateSyncPlan(syncPlan);
      expect(isValid).toBe(true);
    });

    it('should detect invalid file paths', () => {
      const syncPlan = {
        toAdd: [
          { path: '', action: 'add' }, // Empty path
        ],
        toUpdate: [],
        toDelete: [],
      };

      const isValid = syncPlanService.validateSyncPlan(syncPlan);
      expect(isValid).toBe(false);
    });

    it('should detect conflicting operations', () => {
      const syncPlan = {
        toAdd: [
          { path: 'conflicting-file.ts', action: 'add' },
        ],
        toUpdate: [
          { path: 'conflicting-file.ts', action: 'update' }, // Same file in both
        ],
        toDelete: [],
      };

      const isValid = syncPlanService.validateSyncPlan(syncPlan);
      expect(isValid).toBe(false);
    });
  });
});