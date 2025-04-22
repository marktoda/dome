import { DurableObject } from 'cloudflare:workers';
import { createSiloService, SiloService } from './services/siloService';
import { getLogger, logError, metrics } from '@dome/logging';
import { ProviderType, GithubProvider, Provider } from './providers';
import { Bindings } from './types';
import { syncHistoryOperations, syncPlanOperations } from './db/client';
import { ulid } from 'ulid';

/* ------------------------------------------------------------------ */
/*  config                                                            */
/* ------------------------------------------------------------------ */

interface Config {
  userIds: string[];
  cadenceSecs: number;
  providerType: ProviderType;
  cursor: string;
  resourceId: string;
}

const STORAGE_KEY = 'cfg';
const DEFAULT_CFG: Config = {
  userIds: [],
  cadenceSecs: 3600,
  providerType: ProviderType.GITHUB,
  cursor: '',
  resourceId: '',
};

/* ------------------------------------------------------------------ */
/*  durable object                                                    */
/* ------------------------------------------------------------------ */

export class ResourceObject extends DurableObject<Bindings> {
  private cfg: Config = DEFAULT_CFG;
  private silo: SiloService;
  private log = getLogger();

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.silo = createSiloService(env);

    ctx.blockConcurrencyWhile(async () => {
      try {
        this.cfg = await this.loadCfg();
        this.log.info({ resourceId: this.cfg.resourceId }, 'resource loaded');
      } catch {
        /* first run – keep defaults */
      }
    });
  }

  /* ------------------------- public API -------------------------- */

  async initialize(init: Partial<Config>) {
    this.cfg = Object.assign({}, DEFAULT_CFG, init);
    await this.updateCfg(init);
    await this.schedule();
    this.log.info(this.cfg, 'resource initialised');
  }

  async addUser(userId: string) {
    if (!userId || this.cfg.userIds.includes(userId)) return;
    const userIds = this.cfg.userIds;
    userIds.push(userId);
    await this.updateCfg({ userIds: userIds });
    this.log.info({ userId, resourceId: this.cfg.resourceId }, 'user attached');
  }

  async sync() {
    const { resourceId, providerType, cursor } = this.cfg;

    const start = Date.now();
    const userId = this.cfg.userIds[0];
    const provider = this.makeProvider(providerType);

    try {
      const { contents, newCursor } = await provider.pull({ userId, resourceId, cursor });

      if (newCursor) {
        await this.updateCfg({ cursor: newCursor });
      }

      const ids = contents.length ? await this.silo.upload(contents) : [];
      await this.recordHistory(
        'success',
        ids.length,
        contents.map(c => c.metadata?.path ?? 'unknown'),
        start,
      );

      metrics.increment('tsunami.sync.success');
      this.log.info({ resourceId, files: ids.length }, 'sync ok');
    } catch (err) {
      await this.recordHistory('error', 0, [], start, err as Error);
      metrics.increment('tsunami.sync.error');
      logError(this.log, err, 'sync failed', { resourceId });
      throw err;
    }
  }

  info() {
    return this.cfg;
  }

  async alarm() {
    await this.sync();
    await this.schedule();
  }

  /* ------------------------- helpers ---------------------------- */

  private makeProvider(pt: ProviderType): Provider {
    switch (pt) {
      case ProviderType.GITHUB:
        return new GithubProvider(this.env);
      default:
        throw new Error(`Provider ${pt} not implemented`);
    }
  }

  private async recordHistory(
    status: 'success' | 'error',
    filesProcessed: number,
    updatedFiles: string[],
    startMs: number,
    err: Error | null = null,
  ) {
    const syncPlanId = await this.getSyncPlanId();

    await syncHistoryOperations.create(this.env.SYNC_PLAN, {
      syncPlanId,
      resourceId: this.cfg.resourceId,
      provider: this.cfg.providerType,
      userId: this.cfg.userIds[0],
      startedAt: Math.round(startMs / 1000),
      completedAt: Math.round(Date.now() / 1000),
      previousCursor: this.cfg.cursor,
      newCursor: this.cfg.cursor,
      filesProcessed,
      updatedFiles,
      status,
      errorMessage: err?.message,
    });
  }

  private async getSyncPlanId() {
    const rec = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, this.cfg.resourceId);
    return rec?.id ?? ulid();
  }

  private async schedule() {
    await this.ctx.storage.setAlarm(Date.now() + this.cfg.cadenceSecs * 1000);
  }

  private async loadCfg(): Promise<Config> {
    const c = await this.ctx.storage.get<Config>(STORAGE_KEY);
    if (!c) throw new Error('no cfg');
    return c;
  }

  private async updateCfg(newCfg: Partial<Config>): Promise<void> {
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const existingConfig = await this.loadCfg();
        this.cfg = Object.assign({}, existingConfig, newCfg);
        await this.ctx.storage.put(STORAGE_KEY, this.cfg);
      } catch {
        /* first run – keep defaults */
      }
    });
  }

}
