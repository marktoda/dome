import { WorkerEntrypoint } from 'cloudflare:workers';
import { createServiceMetrics, ServiceMetrics } from '../logging/index.js';

export interface BaseWorkerOptions {
  serviceName?: string;
}

export class BaseWorker<Env = unknown, Services = unknown> extends WorkerEntrypoint<Env> {
  private _services?: Services;
  private readonly buildServices: (env: Env) => Services;
  protected metrics?: ServiceMetrics;

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
    }
  }

  protected get services(): Services {
    return (this._services ??= this.buildServices(this.env));
  }
}
