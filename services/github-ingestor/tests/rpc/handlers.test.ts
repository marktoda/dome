import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcHandlers } from '../../src/rpc/handlers';
import { ServiceFactory } from '../../src/services';
import { RepositoryService } from '../../src/services/repository-service';
import { QueueService } from '../../src/queue/service';

// Mock environment
const mockEnv = {
  DB: {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
} as any;

// Mock services
const mockRepositoryService = {
  createRepository: vi.fn(),
  getRepository: vi.fn(),
  updateRepository: vi.fn(),
  deleteRepository: vi.fn(),
  listRepositoriesForUser: vi.fn(),
  resetRetryCount: vi.fn(),
};

// Use vi.mocked to properly type the mock functions
vi.mock('../../src/services/repository-service', () => ({
  RepositoryService: vi.fn().mockImplementation(() => mockRepositoryService),
}));

const mockQueueService = {
  enqueueRepository: vi.fn(),
};

vi.mock('../../src/queue/service', () => ({
  QueueService: vi.fn().mockImplementation(() => mockQueueService),
}));

// Create a mock ServiceFactory class
class MockServiceFactory {
  private env: any;

  constructor(env: any) {
    this.env = env;
  }

  getRepositoryService = vi.fn().mockReturnValue(mockRepositoryService);
  getQueueService = vi.fn().mockReturnValue(mockQueueService);
  getContentService = vi.fn();
  getGitHubService = vi.fn();
  getWebhookService = vi.fn();
  getStatisticsService = vi.fn();
  createIngestor = vi.fn();
  createIngestorFromRepository = vi.fn();
}

// Create an instance of the mock service factory
const mockServiceFactory = new MockServiceFactory(mockEnv) as unknown as ServiceFactory;

vi.mock('../../src/services', () => ({
  ServiceFactory: MockServiceFactory,
}));

describe('RpcHandlers', () => {
  let handlers: RpcHandlers;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new RpcHandlers(mockServiceFactory, mockEnv);
  });

  describe('addRepository', () => {
    it('should create a repository and enqueue a sync job', async () => {
      // Setup
      const repoId = 'repo-123';
      const request = {
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false,
      };

      const mockRepo = {
        id: repoId,
        userId: request.userId,
        provider: request.provider,
        owner: request.owner,
        repo: request.repo,
        branch: request.branch,
        isPrivate: request.isPrivate,
      };

      mockRepositoryService.createRepository.mockResolvedValue(repoId);
      mockRepositoryService.getRepository.mockResolvedValue(mockRepo);

      // Execute
      const result = await handlers.addRepository(request);

      // Verify
      expect(mockRepositoryService.createRepository).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: request.userId,
          provider: request.provider,
          owner: request.owner,
          repo: request.repo,
          branch: request.branch,
          isPrivate: request.isPrivate,
        }),
      );

      expect(mockQueueService.enqueueRepository).toHaveBeenCalledWith(
        repoId,
        request.userId,
        request.provider,
        request.owner,
        request.repo,
        request.branch,
        request.isPrivate,
        undefined,
        undefined,
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: repoId,
          userId: request.userId,
          provider: request.provider,
          owner: request.owner,
          repo: request.repo,
          branch: request.branch,
          isPrivate: request.isPrivate,
        }),
      );
    });

    it('should throw an error if repository creation fails', async () => {
      // Setup
      const request = {
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false,
      };

      const error = new Error('Repository creation failed');
      mockRepositoryService.createRepository.mockRejectedValue(error);

      // Execute & Verify
      await expect(handlers.addRepository(request)).rejects.toThrow(error);
    });
  });

  describe('updateRepository', () => {
    it('should update a repository', async () => {
      // Setup
      const repoId = 'repo-123';
      const request = {
        id: repoId,
        branch: 'develop',
        isPrivate: true,
      };

      const mockRepo = {
        id: repoId,
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'develop',
        isPrivate: true,
      };

      mockRepositoryService.getRepository.mockResolvedValue(mockRepo);
      mockRepositoryService.updateRepository.mockResolvedValue(true);

      // Execute
      const result = await handlers.updateRepository(request);

      // Verify
      expect(mockRepositoryService.updateRepository).toHaveBeenCalledWith(
        repoId,
        expect.objectContaining({
          branch: request.branch,
          isPrivate: request.isPrivate,
        }),
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: repoId,
          branch: request.branch,
          isPrivate: request.isPrivate,
        }),
      );
    });

    it('should throw an error if repository not found', async () => {
      // Setup
      const repoId = 'repo-123';
      const request = {
        id: repoId,
        branch: 'develop',
      };

      mockRepositoryService.getRepository.mockResolvedValue(null);

      // Execute & Verify
      await expect(handlers.updateRepository(request)).rejects.toThrow('Repository not found');
    });
  });

  describe('removeRepository', () => {
    it('should delete a repository', async () => {
      // Setup
      const repoId = 'repo-123';
      mockRepositoryService.deleteRepository.mockResolvedValue(true);

      // Execute
      const result = await handlers.removeRepository(repoId);

      // Verify
      expect(mockRepositoryService.deleteRepository).toHaveBeenCalledWith(repoId);
      expect(result).toEqual({ success: true });
    });

    it('should return success: false if repository not found', async () => {
      // Setup
      const repoId = 'repo-123';
      mockRepositoryService.deleteRepository.mockResolvedValue(false);

      // Execute
      const result = await handlers.removeRepository(repoId);

      // Verify
      expect(mockRepositoryService.deleteRepository).toHaveBeenCalledWith(repoId);
      expect(result).toEqual({ success: false });
    });
  });

  describe('listRepositories', () => {
    it('should list repositories for a user', async () => {
      // Setup
      const userId = 'user-123';
      const provider = 'github';
      const request = { userId, provider };

      const mockRepos = [
        {
          id: 'repo-1',
          userId,
          provider,
          owner: 'testorg',
          repo: 'repo1',
          branch: 'main',
          isPrivate: false,
        },
        {
          id: 'repo-2',
          userId,
          provider,
          owner: 'testorg',
          repo: 'repo2',
          branch: 'main',
          isPrivate: true,
        },
      ];

      mockRepositoryService.listRepositoriesForUser.mockResolvedValue(mockRepos);

      // Execute
      const result = await handlers.listRepositories(request);

      // Verify
      expect(mockRepositoryService.listRepositoriesForUser).toHaveBeenCalledWith(userId, provider);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'repo-1',
          userId,
          provider,
          owner: 'testorg',
          repo: 'repo1',
        }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({
          id: 'repo-2',
          userId,
          provider,
          owner: 'testorg',
          repo: 'repo2',
        }),
      );
    });
  });

  describe('syncRepository', () => {
    it('should trigger a repository sync', async () => {
      // Setup
      const repoId = 'repo-123';
      const request = { id: repoId, force: false };

      const mockRepo = {
        id: repoId,
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false,
      };

      mockRepositoryService.getRepository.mockResolvedValue(mockRepo);

      // Execute
      const result = await handlers.syncRepository(request);

      // Verify
      expect(mockRepositoryService.resetRetryCount).not.toHaveBeenCalled();
      expect(mockQueueService.enqueueRepository).toHaveBeenCalledWith(
        repoId,
        mockRepo.userId,
        mockRepo.provider,
        mockRepo.owner,
        mockRepo.repo,
        mockRepo.branch,
        mockRepo.isPrivate,
        undefined,
        undefined,
      );
      expect(result).toEqual({ success: true });
    });

    it('should reset retry count if force is true', async () => {
      // Setup
      const repoId = 'repo-123';
      const request = { id: repoId, force: true };

      const mockRepo = {
        id: repoId,
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false,
      };

      mockRepositoryService.getRepository.mockResolvedValue(mockRepo);
      mockRepositoryService.resetRetryCount.mockResolvedValue(true);

      // Execute
      const result = await handlers.syncRepository(request);

      // Verify
      expect(mockRepositoryService.resetRetryCount).toHaveBeenCalledWith(repoId);
      expect(mockQueueService.enqueueRepository).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should throw an error if repository not found', async () => {
      // Setup
      const repoId = 'repo-123';
      const request = { id: repoId, force: false };

      mockRepositoryService.getRepository.mockResolvedValue(null);

      // Execute & Verify
      await expect(handlers.syncRepository(request)).rejects.toThrow('Repository not found');
    });
  });
});
