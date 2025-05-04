import { BaseCheckpointSaver } from '@langchain/langgraph';
import { IterableReadableStream } from '@langchain/core/utils/stream';
export { V1Chat } from './v1';
export { V2Chat } from './v2';

export interface IChatGraph {
  stream(i: unknown, o?: Partial<unknown>): Promise<IterableReadableStream<unknown>>;
  invoke(i: unknown, o?: Partial<unknown>): Promise<unknown>;
}

export interface ChatBuilder {
  build(env: Env, cp?: BaseCheckpointSaver): Promise<IChatGraph>;
}
