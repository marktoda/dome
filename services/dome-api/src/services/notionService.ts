import { getLogger } from '@dome/common';
import type { Bindings } from '../types';
import { TsunamiClient } from '@dome/tsunami/client';

const logger = getLogger().child({ component: 'NotionService' });

export class NotionService {
  private env: Bindings;
  private tsunami: TsunamiClient;

  constructor(env: Bindings) {
    this.env = env;
    this.tsunami = new TsunamiClient(env.TSUNAMI);
    logger.info('NotionService initialized');
  }

  private parseCadence(cadence?: string): number {
    if (!cadence) return 3600;
    const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(cadence);
    if (!match) return 3600;
    const [, h, m, s] = match;
    return (parseInt(h || '0') * 3600) + (parseInt(m || '0') * 60) + parseInt(s || '0');
  }

  async registerWorkspace(
    userId: string | undefined,
    data: { workspaceId: string; cadence?: string },
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    logger.info({ userId, data }, 'Registering Notion workspace');
    const cadenceSecs = this.parseCadence(data.cadence);
    return this.tsunami.registerNotionWorkspace(data.workspaceId, userId, cadenceSecs);
  }

  async getWorkspaceHistory(userId: string | undefined, workspaceId: string): Promise<any[]> {
    logger.info({ userId, workspaceId }, 'Fetching Notion workspace history');
    const result = await this.tsunami.getNotionWorkspaceHistory(workspaceId, 10);
    return result.history;
  }

  async triggerSync(userId: string | undefined, workspaceId: string): Promise<void> {
    logger.info({ userId, workspaceId }, 'Triggering Notion workspace sync');
    try {
      await this.tsunami.initializeResource(
        { resourceId: workspaceId, providerType: 'notion', userId },
        0,
      );
    } catch (err) {
      logger.error({ err }, 'Failed to trigger sync');
      throw err;
    }
  }

  async configureOAuth(data: { clientId: string; clientSecret: string; redirectUri: string }): Promise<void> {
    logger.info('Configuring Notion OAuth');
    this.env.NOTION_CLIENT_ID = data.clientId;
    this.env.NOTION_CLIENT_SECRET = data.clientSecret;
    this.env.NOTION_REDIRECT_URI = data.redirectUri;
  }

  async getOAuthUrl(state?: string): Promise<string> {
    const clientId = this.env.NOTION_CLIENT_ID || '';
    const redirectUri = this.env.NOTION_REDIRECT_URI || '';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      owner: 'user',
    });
    if (state) params.set('state', state);
    return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
  }

  async storeIntegration(
    userId: string | undefined,
    authCode: string,
    state?: string,
  ): Promise<{ success: boolean; workspaceId: string; message: string }> {
    if (!userId) throw new Error('userId is required');

    const clientId = this.env.NOTION_CLIENT_ID ?? '';
    const clientSecret = this.env.NOTION_CLIENT_SECRET ?? '';
    const redirectUri = this.env.NOTION_REDIRECT_URI ?? '';

    const resp = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code: authCode, redirect_uri: redirectUri }),
    });

    if (!resp.ok) {
      throw new Error(`Token exchange failed: ${resp.status}`);
    }

    const tokenData: any = await resp.json();

    const result = await this.tsunami.storeNotionOAuthDetails({
      userId,
      accessToken: tokenData.access_token,
      workspaceId: tokenData.workspace_id,
      workspaceName: tokenData.workspace_name,
      workspaceIcon: tokenData.workspace_icon,
      botId: tokenData.bot_id,
      owner: tokenData.owner,
      duplicatedTemplateId: tokenData.duplicated_template_id,
    });

    return { success: result.success, workspaceId: result.workspaceId, message: 'Integration stored successfully.' };
  }
}

export function createNotionService(env: Bindings): NotionService {
  return new NotionService(env);
}
