import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcService } from '../../src/rpc/service';
import { ServiceFactory } from '../../src/services';
import { RpcHandlers } from '../../src/rpc/handlers';

// Mock handlers
const mockHandlers = {
  addRepository: vi.fn(),
  updateRepository: vi.fn(),
  removeRepository: vi.fn(),
  listRepositories: vi.fn(),
  getRepository: vi.fn(),
  syncRepository: vi.fn(),
  getRepositoryStatus: vi.fn(),
  addInstallation: vi.fn(),
  listInstallations: vi.fn(),
  removeInstallation: vi.fn(),
  getStatistics: vi.fn()
};

// Mock RpcHandlers class
vi.mock('../../src/rpc/handlers', () => ({
  RpcHandlers: vi.fn().mockImplementation(() => mockHandlers)
}));

// Mock environment
const mockEnv = {
  DB: {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn()
  }
} as any;

// Mock service factory
const mockServiceFactory = {} as ServiceFactory;

describe('RpcService', () => {
  let rpcService: RpcService;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcService = new RpcService(mockServiceFactory, mockEnv);
  });

  describe('POST /repositories', () => {
    it('should call addRepository handler and return success response', async () => {
      // Setup
      const requestBody = {
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false
      };

      const mockResponse = {
        id: 'repo-123',
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false,
        createdAt: 1234567890,
        updatedAt: 1234567890
      };

      mockHandlers.addRepository.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request('http://localhost/repositories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.addRepository).toHaveBeenCalledWith(requestBody);
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });

    it('should return error response when handler throws', async () => {
      // Setup
      const requestBody = {
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo'
      };

      const error = new Error('Repository creation failed');
      mockHandlers.addRepository.mockRejectedValue(error);

      // Execute
      const request = new Request('http://localhost/repositories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const response = await rpcService.fetch(request);
      
      // Check if the response is valid JSON before parsing
      const text = await response.text();
      let responseBody;
      try {
        responseBody = JSON.parse(text);
      } catch (e) {
        console.error('Failed to parse response as JSON:', text);
      }

      // Verify
      expect(response.status).toBe(500);
      expect(responseBody).toBeDefined();
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toBe('Repository creation failed');
      expect(responseBody).toEqual({
        success: false,
        error: 'Repository creation failed'
      });
    });
  });

  describe('PUT /repositories/:id', () => {
    it('should call updateRepository handler and return success response', async () => {
      // Setup
      const repoId = 'repo-123';
      const requestBody = {
        id: repoId,
        branch: 'develop',
        isPrivate: true
      };

      const mockResponse = {
        id: repoId,
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'develop',
        isPrivate: true,
        createdAt: 1234567890,
        updatedAt: 1234567890
      };

      mockHandlers.updateRepository.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request(`http://localhost/repositories/${repoId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.updateRepository).toHaveBeenCalledWith(requestBody);
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });

  describe('DELETE /repositories/:id', () => {
    it('should call removeRepository handler and return success response', async () => {
      // Setup
      const repoId = 'repo-123';
      mockHandlers.removeRepository.mockResolvedValue({ success: true });

      // Execute
      const request = new Request(`http://localhost/repositories/${repoId}`, {
        method: 'DELETE'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.removeRepository).toHaveBeenCalledWith(repoId);
      expect(responseBody).toEqual({
        success: true
      });
    });
  });

  describe('GET /repositories/:id', () => {
    it('should call getRepository handler and return success response', async () => {
      // Setup
      const repoId = 'repo-123';
      const mockResponse = {
        id: repoId,
        userId: 'user-123',
        provider: 'github',
        owner: 'testorg',
        repo: 'testrepo',
        branch: 'main',
        isPrivate: false,
        createdAt: 1234567890,
        updatedAt: 1234567890
      };

      mockHandlers.getRepository.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request(`http://localhost/repositories/${repoId}`, {
        method: 'GET'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.getRepository).toHaveBeenCalledWith(repoId);
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });

  describe('GET /repositories', () => {
    it('should call listRepositories handler and return success response', async () => {
      // Setup
      const userId = 'user-123';
      const provider = 'github';
      const mockResponse = [
        {
          id: 'repo-1',
          userId,
          provider,
          owner: 'testorg',
          repo: 'repo1',
          branch: 'main',
          isPrivate: false,
          createdAt: 1234567890,
          updatedAt: 1234567890
        },
        {
          id: 'repo-2',
          userId,
          provider,
          owner: 'testorg',
          repo: 'repo2',
          branch: 'main',
          isPrivate: true,
          createdAt: 1234567890,
          updatedAt: 1234567890
        }
      ];

      mockHandlers.listRepositories.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request(`http://localhost/repositories?userId=${userId}&provider=${provider}`, {
        method: 'GET'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.listRepositories).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        provider
      }));
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });

  describe('POST /repositories/:id/sync', () => {
    it('should call syncRepository handler and return success response', async () => {
      // Setup
      const repoId = 'repo-123';
      const requestBody = {
        id: repoId,
        force: true
      };

      mockHandlers.syncRepository.mockResolvedValue({ success: true });

      // Execute
      const request = new Request(`http://localhost/repositories/${repoId}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.syncRepository).toHaveBeenCalledWith(requestBody);
      expect(responseBody).toEqual({
        success: true
      });
    });
  });

  describe('GET /repositories/:id/status', () => {
    it('should call getRepositoryStatus handler and return success response', async () => {
      // Setup
      const repoId = 'repo-123';
      const mockResponse = {
        id: repoId,
        lastSyncedAt: 1234567890,
        lastCommitSha: 'abc123',
        retryCount: 0,
        status: 'idle'
      };

      mockHandlers.getRepositoryStatus.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request(`http://localhost/repositories/${repoId}/status`, {
        method: 'GET'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.getRepositoryStatus).toHaveBeenCalledWith({ id: repoId });
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });

  describe('POST /installations', () => {
    it('should call addInstallation handler and return success response', async () => {
      // Setup
      const requestBody = {
        userId: 'user-123',
        installationId: 'install-123'
      };

      const mockResponse = {
        id: 'cred-123',
        userId: 'user-123',
        provider: 'github',
        installationId: 'install-123',
        account: 'testorg',
        createdAt: 1234567890,
        updatedAt: 1234567890
      };

      mockHandlers.addInstallation.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request('http://localhost/installations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.addInstallation).toHaveBeenCalledWith(requestBody);
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });

  describe('GET /installations', () => {
    it('should call listInstallations handler and return success response', async () => {
      // Setup
      const userId = 'user-123';
      const mockResponse = [
        {
          id: 'cred-123',
          userId: 'user-123',
          provider: 'github',
          installationId: 'install-123',
          account: 'testorg',
          createdAt: 1234567890,
          updatedAt: 1234567890
        }
      ];

      mockHandlers.listInstallations.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request(`http://localhost/installations?userId=${userId}`, {
        method: 'GET'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.listInstallations).toHaveBeenCalledWith(expect.objectContaining({
        userId
      }));
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });

  describe('DELETE /installations/:id', () => {
    it('should call removeInstallation handler and return success response', async () => {
      // Setup
      const installId = 'cred-123';
      mockHandlers.removeInstallation.mockResolvedValue({ success: true });

      // Execute
      const request = new Request(`http://localhost/installations/${installId}`, {
        method: 'DELETE'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.removeInstallation).toHaveBeenCalledWith(installId);
      expect(responseBody).toEqual({
        success: true
      });
    });
  });

  describe('GET /statistics', () => {
    it('should call getStatistics handler and return success response', async () => {
      // Setup
      const userId = 'user-123';
      const timeRange = 'week';
      const mockResponse = {
        totalRepositories: 5,
        totalFiles: 1000,
        totalSizeBytes: 5000000,
        syncedRepositories: 4,
        failedRepositories: 1,
        lastSyncTime: 1234567890
      };

      mockHandlers.getStatistics.mockResolvedValue(mockResponse);

      // Execute
      const request = new Request(`http://localhost/statistics?userId=${userId}&timeRange=${timeRange}`, {
        method: 'GET'
      });

      const response = await rpcService.fetch(request);
      const responseBody = await response.json();

      // Verify
      expect(response.status).toBe(200);
      expect(mockHandlers.getStatistics).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        timeRange
      }));
      expect(responseBody).toEqual({
        success: true,
        data: mockResponse
      });
    });
  });
});