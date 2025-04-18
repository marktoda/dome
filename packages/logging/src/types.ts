import pino from 'pino';

export interface InitOptions {
  idFactory?: () => string;
  extraBindings?: Record<string, unknown>;
  level?: pino.LevelWithSilent;
  serializer?: pino.SerializerFn;
}