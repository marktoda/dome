import { MastraBundler, IBundler } from '../bundler/index.cjs';
import '../base-B_y9sMg0.cjs';
import '@opentelemetry/api';
import '../logger-B8XXh6ya.cjs';
import '../error/index.cjs';
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
