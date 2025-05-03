import { DurableObject } from 'cloudflare:workers';
import { getLogger, logError, metrics } from '@dome/logging';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { ProviderType, GithubProvider, NotionProvider, WebsiteProvider, Provider } from './providers';
import { syncHistoryOperations, syncPlanOperations } from './db/client';
import { ulid } from 'ulid';

/* ------------------------------------------------------------------ */
/*  config                                                            */
/* ------------------------------------------------------------------ */

export interface Config {
  userIds: string[];
  cadenceSecs: number;
  providerType: ProviderType;
  cursor: string;
  resourceId: string; // "owner/repo" for GitHub
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

export class ResourceObject extends DurableObject<Env> {
  protected cfg: Config = DEFAULT_CFG;
  protected readonly silo: SiloClient;
  protected readonly log = getLogger();

  constructor(ctx: any, env: Env) {
    super(ctx, env);
    (this.silo = new SiloClient(env.SILO as unknown as SiloBinding, env.SILO_INGEST_QUEUE)),
      // Load stored configuration (do **not** throw – an empty cfg just means un‑initialised).
      ctx.blockConcurrencyWhile(async () => {
        const stored = await ctx.storage.get(STORAGE_KEY);
        this.cfg = stored ?? DEFAULT_CFG;
        this.log.info({ resourceId: this.cfg.resourceId || '∅' }, 'resource loaded');
      });
  }

  /* ------------------------- public API -------------------------- */

  /** Initialise the resource (idempotent). */
  async initialize(patch: Partial<Config>): Promise<Config> {
    this.cfg = await this.updateCfg(patch);
    await this.scheduleNow();
    this.log.info(this.cfg, 'resource initialised');
    return this.cfg;
  }

  async addUser(userId: string) {
    this.ensureInitialised();
    if (!userId || this.cfg.userIds.includes(userId)) return;
    const next = [...this.cfg.userIds, userId];
    this.cfg = await this.updateCfg({ userIds: next });
    this.log.info({ userId, resourceId: this.cfg.resourceId }, 'user attached');
  }

  async sync() {
    this.ensureInitialised();

    const { resourceId, providerType, cursor } = this.cfg;
    const start = Date.now();
    const userId = this.cfg.userIds[0];
    const provider = this.makeProvider(providerType);

    try {
      const { contents, newCursor } = await provider.pull({ userId, resourceId, cursor });
      if (newCursor) this.cfg = await this.updateCfg({ cursor: newCursor });

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
      logError(err, 'sync failed', { resourceId });
      throw err;
    }
  }

  info(): Config {
    return this.cfg;
  }

  async alarm() {
    await this.loadCfg(); // refresh cfg on cold start
    if (!this.cfg.resourceId) {
      getLogger().info('alarm: resource not initialised, skipping...');
      return; // not initialised yet
    }
    await this.sync();
    await this.schedule();
  }

  /* ------------------------- helpers ---------------------------- */

  private ensureInitialised(): void {
    if (!this.cfg.resourceId) {
      throw new Error('ResourceObject not initialised – call initialize() first');
    }
  }

  private validate(cfg: Config) {
    if (cfg.providerType === ProviderType.GITHUB) {
      if (!cfg.resourceId) throw new Error('GitHub provider requires resourceId');
      const [owner, repo] = cfg.resourceId.split('/');
      if (!owner || !repo)
        throw new Error(`Invalid resourceId "${cfg.resourceId}" – use "owner/repo"`);
    } else if (cfg.providerType === ProviderType.NOTION) {
      if (!cfg.resourceId) throw new Error('Notion provider requires resourceId');
      // Notion workspaceId should be a UUID-like string (typically 32 chars with hyphens)
      const uuidPattern = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
      if (!uuidPattern.test(cfg.resourceId)) {
        throw new Error(`Invalid Notion resourceId "${cfg.resourceId}" – must be a valid workspace ID`);
      }
    } else if (cfg.providerType === ProviderType.WEBSITE) {
      if (!cfg.resourceId) throw new Error('Website provider requires resourceId');
      try {
        const websiteConfig = JSON.parse(cfg.resourceId);
        if (!websiteConfig.url) {
          throw new Error('Website configuration must include a URL property');
        }
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Invalid website configuration: ${error.message}`);
        }
        throw new Error('Invalid website configuration: Unable to parse JSON');
      }
    }
  }

  private makeProvider(pt: ProviderType): Provider {
    switch (pt) {
      case ProviderType.GITHUB:
        return new GithubProvider(this.env);
      case ProviderType.NOTION:
        return new NotionProvider(this.env);
      case ProviderType.WEBSITE:
        return new WebsiteProvider(this.env);
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
    try {
      const syncPlanId = await this.getSyncPlanId();
      await syncHistoryOperations.create(this.env.SYNC_PLAN, {
        syncPlanId,
        resourceId: this.cfg.resourceId,
        provider: this.cfg.providerType,
        userId: this.cfg.userIds[0],
        startedAt: Math.floor(startMs / 1000),
        completedAt: Math.floor(Date.now() / 1000),
        previousCursor: this.cfg.cursor,
        newCursor: this.cfg.cursor,
        filesProcessed,
        updatedFiles,
        status,
        errorMessage: err?.message,
      });
    } catch (error) {
      this.log.error(error, 'error creating sync history');
      throw error;
    }
  }

  private async getSyncPlanId() {
    const rec = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, this.cfg.resourceId);
    if (rec) return rec.id;

    const id = ulid();
    await syncPlanOperations.create(this.env.SYNC_PLAN, {
      id,
      userId: this.cfg.userIds[0],
      provider: this.cfg.providerType,
      resourceId: this.cfg.resourceId,
    });
    return id;
  }

  /* ---------- scheduling --------------------------------------- */

  private async scheduleNow() {
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async schedule() {
    await this.ctx.storage.setAlarm(Date.now() + this.cfg.cadenceSecs * 1000);
  }

  /* ---------- storage helpers ---------------------------------- */

  private async loadCfg(): Promise<Config> {
    const stored = await this.ctx.storage.get<Config>(STORAGE_KEY);
    this.cfg = stored ?? DEFAULT_CFG;
    return this.cfg;
  }

  /**
   * Atomically merge & persist the configuration.
   *
   * As of the 2025‑04 Workers runtime release, any group of writes issued
   * synchronously after the final read (with no intervening awaits) is already
   * committed atomically, so we can simply perform the get/put sequence inside
   * a `blockConcurrencyWhile` to prevent overlapping merges.
   */
  private async updateCfg(patch: Partial<Config>): Promise<Config> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = (await this.ctx.storage.get<Config>(STORAGE_KEY)) ?? DEFAULT_CFG;
      const merged = { ...current, ...patch } as Config;
      this.validate(merged);
      await this.ctx.storage.put(STORAGE_KEY, merged);
      return merged;
    });
  }
}
