import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock modules first - vi.mock calls are hoisted to the top
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Create fixed mock implementations
const mockDbFunctions = {
  get: vi.fn(),
  values: vi.fn(),
};

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: mockDbFunctions.get,
    insert: vi.fn().mockReturnValue({ 
      values: mockDbFunctions.values 
    }),
  }),
}));

vi.mock('bcryptjs', () => ({
  hash: vi.fn().mockResolvedValue('hashed_password'),
  compare: vi.fn().mockResolvedValue(true),
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock_uuid'),
}));

vi.mock('jose', () => ({
  SignJWT: vi.fn().mockReturnValue({
    setProtectedHeader: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue('mock_token'),
  }),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: {
      userId: 'user_123',
      email: 'test@example.com',
      role: 'user',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }
  }),
}));

// Import dependencies after mocks
import { AuthService } from '../../src/services/authService';
import { UserRole } from '../../src/types';
import { AuthError, AuthErrorType } from '../../src/utils/errors';
import * as bcrypt from 'bcryptjs';
import * as jose from 'jose';

describe('AuthService', () => {
  let authService: AuthService;
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock functions
    mockDbFunctions.get.mockReset();
    mockDbFunctions.values.mockReset();

    // Setup mock environment
    mockEnv = {
      AUTH_DB: {},
      AUTH_TOKENS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(null),
      },
    };

    // Create the auth service
    authService = new AuthService(mockEnv);
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      // Setup mock to return null (user doesn't exist)
      mockDbFunctions.get.mockResolvedValueOnce(null);
      mockDbFunctions.values.mockResolvedValueOnce({});

      // Execute
      const result = await authService.register('test@example.com', 'password', 'Test User');

      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: 'mock_uuid',
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
      }));
      
      // Verify DB interactions
      expect(mockDbFunctions.values).toHaveBeenCalledWith(expect.objectContaining({
        email: 'test@example.com',
        name: 'Test User',
      }));
    });

    it('should throw an error if user already exists', async () => {
      // Setup mock to return an existing user
      mockDbFunctions.get.mockResolvedValueOnce({ 
        id: 'existing_id', 
        email: 'test@example.com' 
      });

      // Execute and assert
      await expect(authService.register('test@example.com', 'password'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.USER_EXISTS,
        }));
    });
  });

  describe('login', () => {
    it('should login a user successfully', async () => {
      // Setup mock to return a user
      const mockUser = {
        id: 'user_123',
        email: 'test@example.com',
        password: 'hashed_password',
        name: 'Test User',
        role: UserRole.USER,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      
      mockDbFunctions.get.mockResolvedValueOnce(mockUser);
      
      // Execute
      const result = await authService.login('test@example.com', 'password');
      
      // Assert
      expect(result).toEqual(expect.objectContaining({
        success: true,
        token: 'mock_token',
        user: expect.objectContaining({
          id: 'user_123',
          email: 'test@example.com',
        }),
      }));
    });
    
    it('should throw an error if user not found', async () => {
      // Setup mock to return null (user not found)
      mockDbFunctions.get.mockResolvedValueOnce(null);
      
      // Execute and assert
      await expect(authService.login('nonexistent@example.com', 'password'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.INVALID_CREDENTIALS,
        }));
    });
    
    it('should throw an error if password is invalid', async () => {
      // Setup mock to return a user
      const mockUser = {
        id: 'user_123',
        email: 'test@example.com',
        password: 'hashed_password',
        name: 'Test User',
        role: UserRole.USER,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      
      mockDbFunctions.get.mockResolvedValueOnce(mockUser);
      
      // Override bcrypt.compare for this test only
      (bcrypt.compare as unknown as any).mockResolvedValueOnce(false);
      
      // Execute and assert
      await expect(authService.login('test@example.com', 'wrong_password'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.INVALID_CREDENTIALS,
        }));
    });
    
    it('should handle database errors', async () => {
      // Setup mock to throw an error
      mockDbFunctions.get.mockRejectedValueOnce(new Error('Database connection failed'));
      
      // Execute and assert
      await expect(authService.login('test@example.com', 'password'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.LOGIN_FAILED,
        }));
    });
  });

  describe('validateToken', () => {
    it('should validate a token successfully', async () => {
      // Setup token validation mocks
      // First call to get - checking blacklist
      mockDbFunctions.get.mockResolvedValueOnce(null);
      // Second call to get - getting user
      mockDbFunctions.get.mockResolvedValueOnce({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      // Execute
      const result = await authService.validateToken('valid_token');
      
      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: 'user_123',
        email: 'test@example.com',
      }));
    });
    
    it('should throw an error if token is blacklisted', async () => {
      // Setup mock to return blacklisted token
      mockDbFunctions.get.mockResolvedValueOnce({ 
        token: 'blacklisted_token' 
      });
      
      // Execute and assert
      await expect(authService.validateToken('blacklisted_token'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.INVALID_TOKEN,
        }));
    });
    
    it('should throw an error if user not found after token validation', async () => {
      // Setup mocks
      // First call (blacklist check) - return null (not blacklisted)
      mockDbFunctions.get.mockResolvedValueOnce(null);
      // Second call (get user) - return null (user not found)
      mockDbFunctions.get.mockResolvedValueOnce(null);
      
      // Execute and assert
      await expect(authService.validateToken('valid_token'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.USER_NOT_FOUND,
        }));
    });
    
    it('should throw an error if token verification fails', async () => {
      // Override jose.jwtVerify for this test only
      (jose.jwtVerify as unknown as any).mockRejectedValueOnce(new Error('Invalid token'));
      
      // Execute and assert
      await expect(authService.validateToken('invalid_token'))
        .rejects.toThrow(expect.objectContaining({
          type: AuthErrorType.INVALID_TOKEN,
        }));
    });
  });

  describe('logout', () => {
    it('should logout a user successfully', async () => {
      // Setup mocks
      mockDbFunctions.values.mockResolvedValueOnce({});
      
      // Execute
      const result = await authService.logout('valid_token', 'user_123');
      
      // Assert
      expect(result).toBe(true);
      expect(mockDbFunctions.values).toHaveBeenCalledWith(expect.objectContaining({
        token: 'valid_token',
        userId: 'user_123',
      }));
    });
  });

  describe('getUserById', () => {
    it('should get a user by ID successfully', async () => {
      // Setup mock to return a user
      mockDbFunctions.get.mockResolvedValueOnce({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      // Execute
      const result = await authService.getUserById('user_123');
      
      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: 'user_123',
        email: 'test@example.com',
      }));
    });
    
    it('should return null if user not found', async () => {
      // Setup mock to return null
      mockDbFunctions.get.mockResolvedValueOnce(null);
      
      // Execute
      const result = await authService.getUserById('nonexistent_id');
      
      // Assert
      expect(result).toBeNull();
    });
    
    it('should return null if database error occurs', async () => {
      // Setup mock to throw an error
      mockDbFunctions.get.mockRejectedValueOnce(new Error('Database connection failed'));
      
      // Execute
      const result = await authService.getUserById('user_123');
      
      // Assert
      expect(result).toBeNull();
    });
  });
});
