import { MastraBundler, IBundler } from '../bundler/index.js';
import '../base-ClrXcCRx.js';
import '@opentelemetry/api';
import '../logger-Bpa2oLL4.js';
import '../error/index.js';
import 'stream';
import '@opentelemetry/sdk-trace-base';

interface IDeployer extends IBundler {
    deploy(outputDirectory: string): Promise<void>;
}
declare abstract class MastraDeployer extends MastraBundler implements IDeployer {
    constructor({ name }: {
        name: string;
    });
    abstract deploy(outputDirectory: string): Promise<void>;
}

export { type IDeployer, MastraDeployer };
