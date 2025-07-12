import { M as MastraBase } from '../base-B_y9sMg0.cjs';
import { VectorFilter } from './filter/index.cjs';
import '@opentelemetry/api';
import '../logger-B8XXh6ya.cjs';
import '../error/index.cjs';
import 'stream';
import '@opentelemetry/sdk-trace-base';

interface QueryResult {
    id: string;
    score: number;
    metadata?: Record<string, any>;
    vector?: number[];
    /**
     * The document content, if available.
     * Note: Currently only supported by Chroma vector store.
     * For other vector stores, documents should be stored in metadata.
     */
    document?: string;
}
interface IndexStats {
    dimension: number;
    count: number;
    metric?: 'cosine' | 'euclidean' | 'dotproduct';
}
interface UpsertVectorParams {
    indexName: string;
    vectors: number[][];
    metadata?: Record<string, any>[];
    ids?: string[];
}
interface CreateIndexParams {
    indexName: string;
    dimension: number;
    metric?: 'cosine' | 'euclidean' | 'dotproduct';
}
interface QueryVectorParams<Filter = VectorFilter> {
    indexName: string;
    queryVector: number[];
    topK?: number;
    filter?: Filter;
    includeVector?: boolean;
}
interface DescribeIndexParams {
    indexName: string;
}
interface DeleteIndexParams {
    indexName: string;
}
interface UpdateVectorParams {
    indexName: string;
    id: string;
    update: {
        vector?: number[];
        metadata?: Record<string, any>;
    };
}
interface DeleteVectorParams {
    indexName: string;
    id: string;
}

declare abstract class MastraVector<Filter = VectorFilter> extends MastraBase {
    constructor();
    get indexSeparator(): string;
    abstract query(params: QueryVectorParams<Filter>): Promise<QueryResult[]>;
    abstract upsert(params: UpsertVectorParams): Promise<string[]>;
    abstract createIndex(params: CreateIndexParams): Promise<void>;
    abstract listIndexes(): Promise<string[]>;
    abstract describeIndex(params: DescribeIndexParams): Promise<IndexStats>;
    abstract deleteIndex(params: DeleteIndexParams): Promise<void>;
    abstract updateVector(params: UpdateVectorParams): Promise<void>;
    abstract deleteVector(params: DeleteVectorParams): Promise<void>;
    protected validateExistingIndex(indexName: string, dimension: number, metric: string): Promise<void>;
}

export { type CreateIndexParams, type DeleteIndexParams, type DeleteVectorParams, type DescribeIndexParams, type IndexStats, MastraVector, type QueryResult, type QueryVectorParams, type UpdateVectorParams, type UpsertVectorParams };
