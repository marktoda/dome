import { M as MastraBase } from '../base-B_y9sMg0.cjs';
import '@opentelemetry/api';
import '../logger-B8XXh6ya.cjs';
import '../error/index.cjs';
import 'stream';
import '@opentelemetry/sdk-trace-base';

interface BuiltInModelConfig {
    provider: string;
    name: string;
    apiKey?: string;
}
interface TTSConfig {
    model: BuiltInModelConfig;
}
declare abstract class MastraTTS extends MastraBase {
    model: BuiltInModelConfig;
    constructor({ model }: TTSConfig);
    traced<T extends Function>(method: T, methodName: string): T;
    abstract generate({ text }: {
        text: string;
    }): Promise<any>;
    abstract stream({ text }: {
        text: string;
    }): Promise<any>;
}

export { MastraTTS, type TTSConfig };
