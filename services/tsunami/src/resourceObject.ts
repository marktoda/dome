import { DurableObject } from 'cloudflare:workers';
import { getLogger, logError, metrics } from '@dome/common';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { IngestQueue } from '@dome/silo/queues';

export interface ServiceEnv extends Omit<Cloudflare.Env, 'SILO'> {
  SILO: SiloBinding;
}
import {
  ProviderType,
  GithubProvider,
  NotionProvider,
  WebsiteProvider,
  Provider,
} from './providers';
import { syncHistoryOperations, syncPlanOperations } from './db/client';
import { ulid } from 'ulid';
import { z } from 'zod';

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

// Zod schema for run-time validation & future-proofing
const ConfigSchema = z.object({
  userIds: z.array(z.string()),
  cadenceSecs: z.number().int().positive(),
  providerType: z.nativeEnum(ProviderType),
  cursor: z.string(),
  resourceId: z.string(),
});

/* ------------------------------------------------------------------ */
/*  durable object                                                    */
/* ------------------------------------------------------------------ */

export class ResourceObject extends DurableObject<ServiceEnv> {
  protected cfg: Config = DEFAULT_CFG;
  protected readonly silo: SiloClient;
  protected readonly log = getLogger();

  constructor(ctx: any, env: ServiceEnv) {
    super(ctx, env);
    (this.silo = new SiloClient(env.SILO, new IngestQueue(env.SILO_INGEST_QUEUE))),
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
    const parsed = ConfigSchema.safeParse(cfg);
    if (!parsed.success) {
      throw new Error(`Invalid configuration: ${parsed.error.message}`);
    }

    // provider-specific resourceId validation
    switch (cfg.providerType) {
      case ProviderType.GITHUB: {
        const [owner, repo] = cfg.resourceId.split('/');
        if (!owner || !repo) {
          throw new Error(`Invalid GitHub resourceId "${cfg.resourceId}" – use "owner/repo"`);
        }
        break;
      }
      case ProviderType.NOTION: {
        const uuidPattern = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
        if (cfg.resourceId && !uuidPattern.test(cfg.resourceId)) {
          throw new Error(
            `Invalid Notion resourceId "${cfg.resourceId}" – expected a workspace UUID`,
          );
        }
        break;
      }
      case ProviderType.WEBSITE: {
        try {
          const websiteConfig = JSON.parse(cfg.resourceId);
          if (!websiteConfig.url) throw new Error('property "url" missing');
        } catch (err) {
          throw new Error(`Invalid website resourceId: ${(err as Error).message}`);
        }
        break;
      }
    }
  }

  private makeProvider(pt: ProviderType): Provider {
    const factory = PROVIDERS[pt];
    if (!factory) throw new Error(`Provider ${pt} not implemented`);
    return factory(this.env);
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
      logError(error, 'error creating sync history');
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

/* ------------------------------------------------------------------ */
/*  provider factory                                                  */
/* ------------------------------------------------------------------ */

/** Map provider-type → factory so we don't need a switch every time. */
const PROVIDERS: Record<ProviderType, (env: ServiceEnv) => Provider> = {
  [ProviderType.GITHUB]: env => new GithubProvider(env),
  [ProviderType.NOTION]: env => new NotionProvider(env),
  [ProviderType.WEBSITE]: env => new WebsiteProvider(env),
};
