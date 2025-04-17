/**
 * Type definitions for Cloudflare Worker environment in tests
 */

declare class D1Database {
  prepare(query: string): any;
  batch(statements: any[]): Promise<any>;
  exec(query: string): Promise<any>;
}

declare class VectorizeIndex {
  query(vector: number[], options?: any): Promise<any>;
  insert(vectors: any[], options?: any): Promise<any>;
  upsert(vectors: any[], options?: any): Promise<any>;
  delete(ids: string[], options?: any): Promise<any>;
}

declare class R2Bucket {
  get(key: string): Promise<any>;
  put(key: string, value: any, options?: any): Promise<any>;
  delete(key: string): Promise<any>;
  list(options?: any): Promise<any>;
}

declare class Queue<T = any> {
  send(message: T): Promise<any>;
  sendBatch(messages: T[]): Promise<any>;
}