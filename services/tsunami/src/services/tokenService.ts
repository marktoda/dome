// services/tsunami/src/services/tokenService.ts
import { drizzle } from 'drizzle-orm/d1';
import { getLogger, logError } from '@dome/common';
import { oauthTokens, schema } from '../db/schema';
import type { NotionOAuthDetails, GithubOAuthDetails } from '../client/types'; // Added GithubOAuthDetails
import { eq, and } from 'drizzle-orm';
import { ulid } from 'ulid';

// Define the structure for the data to be inserted/updated, matching oauthTokens table
export interface OAuthTokenRecord { // Exporting for potential use elsewhere, e.g. provider classes
  id?: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  accessToken: string; // TODO: Encrypt
  refreshToken?: string | null; // TODO: Encrypt
  expiresAt?: number | null;
  tokenType?: string | null;
  scope?: string | null;
  providerWorkspaceId?: string | null;
  metadata?: string | null; // JSON string
  createdAt?: number;
  updatedAt?: number;
}

export class TokenService {
  private logger = getLogger().child({ component: 'TokenService' });
  private db;

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema });
  }

  /**
   * Stores or updates an OAuth token for a user and provider.
   * Notion tokens are workspace-specific, so providerWorkspaceId is key.
   */
  async storeNotionToken(details: NotionOAuthDetails): Promise<{ success: boolean; tokenId: string; workspaceId: string }> {
    this.logger.info({ userId: details.userId, workspaceId: details.workspaceId, provider: 'notion' }, 'Storing Notion token');
    try {
      // TODO: Implement encryption for accessToken
      const metadataToStore = {
        workspaceName: details.workspaceName,
        workspaceIcon: details.workspaceIcon,
        owner: details.owner, // Storing raw owner for now
        duplicatedTemplateId: details.duplicatedTemplateId,
      };

      const values: Omit<OAuthTokenRecord, 'id' | 'createdAt' | 'updatedAt'> = { // Use Omit for insert/update values
        userId: details.userId,
        provider: 'notion',
        providerAccountId: details.botId, // Notion's bot_id is the account ID for the integration
        accessToken: details.accessToken,
        providerWorkspaceId: details.workspaceId,
        metadata: JSON.stringify(metadataToStore),
        // refreshToken, expiresAt, tokenType, scope can be added if Notion provides them
      };
      
      const now = Math.floor(Date.now() / 1000);

      // Upsert logic: Check if a token for this user, provider, and workspaceId already exists
      const existingToken = await this.db.query.oauthTokens.findFirst({
        where: and(
          eq(oauthTokens.userId, details.userId),
          eq(oauthTokens.provider, 'notion'),
          eq(oauthTokens.providerWorkspaceId, details.workspaceId)
        ),
      });

      let tokenId: string;
      if (existingToken) {
        tokenId = existingToken.id;
        await this.db.update(oauthTokens)
          .set({ ...values, updatedAt: now })
          .where(eq(oauthTokens.id, tokenId));
        this.logger.info({ tokenId }, 'Updated existing Notion token');
      } else {
        tokenId = ulid();
        await this.db.insert(oauthTokens).values({ 
          ...values, 
          id: tokenId,
          createdAt: now, 
          updatedAt: now 
        });
        this.logger.info({ tokenId }, 'Inserted new Notion token');
      }
      
      return { success: true, tokenId, workspaceId: details.workspaceId };
    } catch (error) {
      logError(error, 'Error storing Notion token', { userId: details.userId, workspaceId: details.workspaceId });
      throw error; // Re-throw for the caller to handle
    }
  }

  /**
   * Retrieves an OAuth token for a user, provider, and optionally a specific workspace.
   */
  async getToken(userId: string, provider: string, providerWorkspaceId?: string): Promise<OAuthTokenRecord | null> {
    this.logger.debug({ userId, provider, providerWorkspaceId }, 'Retrieving token');
    try {
      const conditions = [
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.provider, provider),
      ];
      if (providerWorkspaceId) {
        // Ensure providerWorkspaceId is not null before adding to condition if the column can be null
        conditions.push(eq(oauthTokens.providerWorkspaceId, providerWorkspaceId));
      } else {
        // If providerWorkspaceId is not given, and the column can be null, 
        // you might need to explicitly check for null or handle cases where it's not applicable.
        // For Notion, providerWorkspaceId is expected. For GitHub user token, it might be null.
      }

      const tokenRecord = await this.db.query.oauthTokens.findFirst({
        where: and(...conditions),
      });

      if (tokenRecord) {
        // TODO: Decrypt accessToken and refreshToken here
        return tokenRecord as OAuthTokenRecord; // Cast needed due to Drizzle's return type
      }
      return null;
    } catch (error) {
      logError(error, 'Error retrieving token', { userId, provider, providerWorkspaceId });
      throw error;
    }
  }

  /**
   * Stores or updates an OAuth token for a GitHub user.
   * GitHub user tokens are typically not workspace-specific in the same way Notion's are,
   * so providerWorkspaceId might be null or not used for user-level tokens.
   */
  async storeGithubToken(details: GithubOAuthDetails): Promise<{ success: boolean; tokenId: string; githubUserId: string }> {
    this.logger.info({ userId: details.userId, githubUserId: details.providerAccountId, provider: 'github' }, 'Storing GitHub token');
    try {
      // TODO: Implement encryption for accessToken
      const values: Omit<OAuthTokenRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: details.userId,
        provider: 'github',
        providerAccountId: details.providerAccountId, // GitHub User ID
        accessToken: details.accessToken,
        scope: details.scope,
        tokenType: details.tokenType,
        metadata: details.metadata ? JSON.stringify(details.metadata) : null,
        // providerWorkspaceId is likely null for GitHub user tokens unless it's for an org app
      };

      const now = Math.floor(Date.now() / 1000);

      // Upsert logic: Check if a token for this user and providerAccountId already exists
      // For GitHub, providerAccountId (GitHub user ID) should be unique per user for this provider.
      const existingToken = await this.db.query.oauthTokens.findFirst({
        where: and(
          eq(oauthTokens.userId, details.userId),
          eq(oauthTokens.provider, 'github'),
          eq(oauthTokens.providerAccountId, details.providerAccountId)
        ),
      });

      let tokenId: string;
      if (existingToken) {
        tokenId = existingToken.id;
        await this.db.update(oauthTokens)
          .set({ ...values, updatedAt: now })
          .where(eq(oauthTokens.id, tokenId));
        this.logger.info({ tokenId, githubUserId: details.providerAccountId }, 'Updated existing GitHub token');
      } else {
        tokenId = ulid();
        await this.db.insert(oauthTokens).values({
          ...values,
          id: tokenId,
          createdAt: now,
          updatedAt: now,
        });
        this.logger.info({ tokenId, githubUserId: details.providerAccountId }, 'Inserted new GitHub token');
      }

      return { success: true, tokenId, githubUserId: details.providerAccountId };
    } catch (error) {
      logError(error, 'Error storing GitHub token', { userId: details.userId, githubUserId: details.providerAccountId });
      throw error; // Re-throw for the caller to handle
    }
  }
  
  // TODO: Add methods for deleting tokens, refreshing tokens (if applicable)
}