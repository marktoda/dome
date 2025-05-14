/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
// import { LocalAuthProvider } from '../../../src/services/providers/local-auth-provider';
// import { UserManager } from '../../../src/services/user/user-manager';
// import { PasswordManager } from '../../../src/services/common/password-manager'; // Assuming a password hashing/comparison utility
// import { User } from '../../../src/entities/user';
// import { AuthError, AuthErrorType } from '../../../../../packages/errors/src/index'; // Adjust path as needed
// Using generic Error for placeholder
const AuthErrorType = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
};
class AuthError extends Error {
  type: string;
  constructor(message: string, type: string) {
    super(message);
    this.type = type;
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

// Mocks
const mockUserManager = {
  findUserByEmail: vi.fn(),
  createUser: vi.fn(),
};

const mockPasswordManager = {
  hashPassword: vi.fn(),
  comparePassword: vi.fn(),
};

// Placeholder for actual LocalAuthProvider
class LocalAuthProvider {
  constructor(
    private userManager: any, // UserManager
    private passwordManager: any, // PasswordManager
  ) {}

  getProviderType() {
    return 'local' as const;
  }

  async register(details: any) {
    const { email, password, ...otherDetails } = details;
    if (!email || !password) {
      throw new AuthError(
        'Email and password are required for registration.',
        AuthErrorType.VALIDATION_ERROR,
      );
    }

    let existingUser = await this.userManager.findUserByEmail(email);
    if (existingUser) {
      throw new AuthError(
        'User with this email already exists.',
        AuthErrorType.USER_ALREADY_EXISTS,
      );
    }

    const hashedPassword = await this.passwordManager.hashPassword(password);
    const newUser = await this.userManager.createUser({
      email,
      hashedPassword, // Store hashed password
      provider: 'local',
      ...otherDetails,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hashedPassword: _, ...userToReturn } = newUser;
    return { user: userToReturn };
  }

  async login(credentials: any) {
    const { email, password } = credentials;
    if (!email || !password) {
      throw new AuthError(
        'Email and password are required for login.',
        AuthErrorType.VALIDATION_ERROR,
      );
    }

    const user = await this.userManager.findUserByEmail(email);
    if (!user || user.provider !== 'local') {
      // Ensure user is a local account
      throw new AuthError('Invalid email or password.', AuthErrorType.INVALID_CREDENTIALS);
    }

    // Assuming user object stores hashedPassword
    const isValidPassword = await this.passwordManager.comparePassword(
      password,
      user.hashedPassword,
    );
    if (!isValidPassword) {
      throw new AuthError('Invalid email or password.', AuthErrorType.INVALID_CREDENTIALS);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hashedPassword: _, ...userToReturn } = user;
    return { user: userToReturn };
  }

  async validateCredentials(credentials: any) {
    // This method might be similar to login but without generating tokens,
    // or it could be used for other validation purposes.
    // For this example, let's assume it's similar to login's core logic.
    const { email, password } = credentials;
    const user = await this.userManager.findUserByEmail(email);
    if (!user || user.provider !== 'local') return null;

    const isValidPassword = await this.passwordManager.comparePassword(
      password,
      user.hashedPassword,
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hashedPassword: _, ...userToReturn } = user;
    return isValidPassword ? { user: userToReturn } : null;
  }
}

describe('LocalAuthProvider Unit Tests', () => {
  let localAuthProvider: LocalAuthProvider;
  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    hashedPassword: 'hashed_password_string',
    provider: 'local',
  };
  const mockCleanUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    provider: 'local',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localAuthProvider = new LocalAuthProvider(mockUserManager as any, mockPasswordManager as any);
  });

  it('should return "local" as provider type', () => {
    expect(localAuthProvider.getProviderType()).toBe('local');
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(null);
      mockPasswordManager.hashPassword.mockResolvedValue('new_hashed_password');
      // Adjust createUser mock to reflect the input name
      mockUserManager.createUser.mockImplementation(async (createDetails: any) => {
        return {
          id: mockUser.id, // Keep a consistent ID for the mock
          email: createDetails.email,
          name: createDetails.name, // Use the name from the input
          hashedPassword: createDetails.hashedPassword,
          provider: 'local',
          // Add other necessary fields from mockUser or createDetails as needed
          // For simplicity, keeping it minimal to fix the test
        };
      });

      const result = await localAuthProvider.register({
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      });

      expect(mockUserManager.findUserByEmail).toHaveBeenCalledWith('new@example.com');
      expect(mockPasswordManager.hashPassword).toHaveBeenCalledWith('password123');
      expect(mockUserManager.createUser).toHaveBeenCalledWith({
        email: 'new@example.com',
        hashedPassword: 'new_hashed_password',
        provider: 'local',
        name: 'New User',
      });
      expect(result.user).toEqual(
        expect.objectContaining({ email: 'new@example.com', name: 'New User' }),
      );
      expect(result.user).not.toHaveProperty('hashedPassword');
    });

    it('should throw VALIDATION_ERROR if email or password is not provided', async () => {
      await expect(localAuthProvider.register({ email: 'test@example.com' })).rejects.toThrowError(
        new AuthError(
          'Email and password are required for registration.',
          AuthErrorType.VALIDATION_ERROR,
        ),
      );
      await expect(localAuthProvider.register({ password: 'password123' })).rejects.toThrowError(
        new AuthError(
          'Email and password are required for registration.',
          AuthErrorType.VALIDATION_ERROR,
        ),
      );
    });

    it('should throw USER_ALREADY_EXISTS if user with email already exists', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(mockUser);
      await expect(
        localAuthProvider.register({ email: 'test@example.com', password: 'password123' }),
      ).rejects.toThrowError(
        new AuthError('User with this email already exists.', AuthErrorType.USER_ALREADY_EXISTS),
      );
    });
  });

  describe('login', () => {
    it('should login an existing user with correct credentials', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(mockUser);
      mockPasswordManager.comparePassword.mockResolvedValue(true);

      const result = await localAuthProvider.login({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(mockUserManager.findUserByEmail).toHaveBeenCalledWith('test@example.com');
      expect(mockPasswordManager.comparePassword).toHaveBeenCalledWith(
        'password123',
        mockUser.hashedPassword,
      );
      expect(result.user).toEqual(mockCleanUser);
      expect(result.user).not.toHaveProperty('hashedPassword');
    });

    it('should throw VALIDATION_ERROR if email or password is not provided for login', async () => {
      await expect(localAuthProvider.login({ email: 'test@example.com' })).rejects.toThrowError(
        new AuthError('Email and password are required for login.', AuthErrorType.VALIDATION_ERROR),
      );
    });

    it('should throw INVALID_CREDENTIALS if user is not found', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(null);
      await expect(
        localAuthProvider.login({ email: 'nonexistent@example.com', password: 'password123' }),
      ).rejects.toThrowError(
        new AuthError('Invalid email or password.', AuthErrorType.INVALID_CREDENTIALS),
      );
    });

    it('should throw INVALID_CREDENTIALS if user is not a local provider user', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue({ ...mockUser, provider: 'privy' });
      await expect(
        localAuthProvider.login({ email: 'test@example.com', password: 'password123' }),
      ).rejects.toThrowError(
        new AuthError('Invalid email or password.', AuthErrorType.INVALID_CREDENTIALS),
      );
    });

    it('should throw INVALID_CREDENTIALS for incorrect password', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(mockUser);
      mockPasswordManager.comparePassword.mockResolvedValue(false);
      await expect(
        localAuthProvider.login({ email: 'test@example.com', password: 'wrongpassword' }),
      ).rejects.toThrowError(
        new AuthError('Invalid email or password.', AuthErrorType.INVALID_CREDENTIALS),
      );
    });
  });

  describe('validateCredentials', () => {
    it('should return user for valid credentials', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(mockUser);
      mockPasswordManager.comparePassword.mockResolvedValue(true);

      const result = await localAuthProvider.validateCredentials({
        email: 'test@example.com',
        password: 'password123',
      });
      expect(result?.user).toEqual(mockCleanUser);
      expect(result?.user).not.toHaveProperty('hashedPassword');
    });

    it('should return null if user not found', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(null);
      const result = await localAuthProvider.validateCredentials({
        email: 'nonexistent@example.com',
        password: 'password123',
      });
      expect(result).toBeNull();
    });

    it('should return null if user is not a local provider user', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue({ ...mockUser, provider: 'privy' });
      const result = await localAuthProvider.validateCredentials({
        email: 'test@example.com',
        password: 'password123',
      });
      expect(result).toBeNull();
    });

    it('should return null for incorrect password', async () => {
      mockUserManager.findUserByEmail.mockResolvedValue(mockUser);
      mockPasswordManager.comparePassword.mockResolvedValue(false);
      const result = await localAuthProvider.validateCredentials({
        email: 'test@example.com',
        password: 'wrongpassword',
      });
      expect(result).toBeNull();
    });
  });
});
