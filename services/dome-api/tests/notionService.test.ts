import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';

vi.mock('@dome/common', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(), child: vi.fn().mockReturnThis() }),
}));

vi.mock('@dome/tsunami/client', () => {
  return {
    TsunamiClient: vi.fn().mockImplementation(() => ({
      registerNotionWorkspace: vi.fn(),
      getNotionWorkspaceHistory: vi.fn(),
      initializeResource: vi.fn(),
      storeNotionOAuthDetails: vi.fn(),
    })),
  };
});

let NotionService: typeof import('../src/services/notionService').NotionService;
let TsunamiClient: any;

beforeAll(async () => {
  const mod = await import('../src/services/notionService');
  NotionService = mod.NotionService;
  TsunamiClient = (await import('@dome/tsunami/client')).TsunamiClient;
});

const createEnv = (): Bindings => ({
  TSUNAMI: {} as any,
  D1_DATABASE: {} as any,
  VECTORIZE: {} as any,
  RAW: {} as any,
  EVENTS: {} as any,
  SILO_INGEST_QUEUE: {} as any,
  SILO: {} as any,
  CHAT: {} as any,
  AI_PROCESSOR: {} as any,
  NOTION_CLIENT_ID: 'id',
  NOTION_CLIENT_SECRET: 'secret',
  NOTION_REDIRECT_URI: 'https://cb',
} as any);

describe('NotionService', () => {
  let env: Bindings;
  let service: any;
  let client: any;

  beforeEach(() => {
    env = createEnv();
    service = new NotionService(env);
    client = (TsunamiClient as any).mock.results.at(-1).value;
  });

  it('registerWorkspace forwards to tsunami client', async () => {
    client.registerNotionWorkspace.mockResolvedValue({ id: '1', resourceId: 'ws', wasInitialised: true });
    const res = await service.registerWorkspace('u1', { workspaceId: 'ws', cadence: 'PT1H' });
    expect(client.registerNotionWorkspace).toHaveBeenCalledWith('ws', 'u1', 3600);
    expect(res).toEqual({ id: '1', resourceId: 'ws', wasInitialised: true });
  });

  it('getWorkspaceHistory returns history', async () => {
    client.getNotionWorkspaceHistory.mockResolvedValue({ workspaceId: 'ws', resourceId: 'ws', history: [{ id: 1 }] });
    const res = await service.getWorkspaceHistory('u1', 'ws');
    expect(client.getNotionWorkspaceHistory).toHaveBeenCalledWith('ws', 10);
    expect(res).toEqual([{ id: 1 }]);
  });

  it('triggerSync calls initializeResource', async () => {
    client.initializeResource.mockResolvedValue(true);
    await service.triggerSync('u1', 'ws');
    expect(client.initializeResource).toHaveBeenCalledWith({ resourceId: 'ws', providerType: 'notion', userId: 'u1' }, 0);
  });

  it('configureOAuth stores values in env', async () => {
    await service.configureOAuth({ clientId: 'n', clientSecret: 's', redirectUri: 'https://x' });
    expect(env.NOTION_CLIENT_ID).toBe('n');
    expect(env.NOTION_CLIENT_SECRET).toBe('s');
    expect(env.NOTION_REDIRECT_URI).toBe('https://x');
  });

  it('getOAuthUrl constructs url', async () => {
    const url = await service.getOAuthUrl('state');
    expect(url).toContain('client_id=id');
    expect(url).toContain(encodeURIComponent('https://cb'));
    expect(url).toContain('state=state');
  });

  it('storeIntegration exchanges code and stores via tsunami', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'tok',
        workspace_id: 'ws',
        workspace_name: 'name',
        workspace_icon: 'icon',
        bot_id: 'bot',
        owner: {},
      }),
    }) as any;

    client.storeNotionOAuthDetails.mockResolvedValue({ success: true, workspaceId: 'ws' });

    const res = await service.storeIntegration('u1', 'code');

    expect(fetch).toHaveBeenCalled();
    expect(client.storeNotionOAuthDetails).toHaveBeenCalledWith({
      userId: 'u1',
      accessToken: 'tok',
      workspaceId: 'ws',
      workspaceName: 'name',
      workspaceIcon: 'icon',
      botId: 'bot',
      owner: {},
      duplicatedTemplateId: undefined,
    });
    expect(res).toEqual({ success: true, workspaceId: 'ws', message: 'Integration stored successfully.' });
  });
});
