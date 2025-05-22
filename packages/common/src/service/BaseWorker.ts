import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  createServiceMetrics,
  ServiceMetrics,
  trackedFetch as baseTrackedFetch,
} from '../logging/index.js';
import { getLogger } from '../context/index.js';
import { createServiceWrapper } from '../utils/functionWrapper.js';

export interface BaseWorkerOptions {
  serviceName?: string;
}

export class BaseWorker<Env = unknown, Services = unknown> extends WorkerEntrypoint<Env> {
  private _services?: Services;
  private readonly buildServices: (env: Env) => Services;
  protected metrics?: ServiceMetrics;
  protected logger = getLogger();
  protected wrap: <T>(meta: Record<string, unknown>, fn: () => Promise<T>) => Promise<T> = async (_m, fn) => fn();
  protected trackedFetch = baseTrackedFetch;

  constructor(
    ctx: any,
    env: Env,
    buildServices: (env: Env) => Services,
    options: BaseWorkerOptions = {},
  ) {
    super(ctx, env);
    this.buildServices = buildServices;
    if (options.serviceName) {
      this.metrics = createServiceMetrics(options.serviceName);
      this.logger = getLogger().child({ service: options.serviceName });
      this.wrap = createServiceWrapper(options.serviceName);
    }
  }

  protected get services(): Services {
    return (this._services ??= this.buildServices(this.env));
  }
}
