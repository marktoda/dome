-- Dome2 RAG Platform Database Schema

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Create schemas
CREATE SCHEMA IF NOT EXISTS documents;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS audit;

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Documents metadata table
CREATE TABLE IF NOT EXISTS documents.metadata (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id VARCHAR(255) UNIQUE NOT NULL,
    source VARCHAR(50) NOT NULL CHECK (source IN ('github', 'notion', 'slack', 'linear')),
    source_id VARCHAR(255) NOT NULL,
    source_url TEXT,
    title TEXT,
    author VARCHAR(255),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    visibility VARCHAR(20) NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private', 'internal')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    indexed_at TIMESTAMP WITH TIME ZONE,
    version INTEGER DEFAULT 1,
    is_deleted BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    UNIQUE(source, source_id, org_id)
);

-- Create indexes for documents.metadata
CREATE INDEX idx_documents_metadata_source ON documents.metadata(source);
CREATE INDEX idx_documents_metadata_org_id ON documents.metadata(org_id);
CREATE INDEX idx_documents_metadata_created_at ON documents.metadata(created_at);
CREATE INDEX idx_documents_metadata_updated_at ON documents.metadata(updated_at);
CREATE INDEX idx_documents_metadata_metadata ON documents.metadata USING GIN(metadata);
CREATE INDEX idx_documents_metadata_title_trgm ON documents.metadata USING GIN(title gin_trgm_ops);

-- Chunks table for storing document chunks
CREATE TABLE IF NOT EXISTS documents.chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chunk_id VARCHAR(255) UNIQUE NOT NULL,
    document_id UUID NOT NULL REFERENCES documents.metadata(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_index INTEGER NOT NULL,
    end_index INTEGER NOT NULL,
    embedding_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    UNIQUE(document_id, chunk_index)
);

-- Create indexes for documents.chunks
CREATE INDEX idx_chunks_document_id ON documents.chunks(document_id);
CREATE INDEX idx_chunks_embedding_id ON documents.chunks(embedding_id);
CREATE INDEX idx_chunks_metadata ON documents.chunks USING GIN(metadata);

-- Embeddings cache table
CREATE TABLE IF NOT EXISTS documents.embeddings_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    text_hash VARCHAR(64) UNIQUE NOT NULL,
    model VARCHAR(100) NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    accessed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    access_count INTEGER DEFAULT 1
);

-- Create index for embeddings cache
CREATE INDEX idx_embeddings_cache_text_hash ON documents.embeddings_cache(text_hash);
CREATE INDEX idx_embeddings_cache_accessed_at ON documents.embeddings_cache(accessed_at);

-- API keys table
CREATE TABLE IF NOT EXISTS auth.api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key_hash VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    permissions JSONB DEFAULT '[]',
    rate_limit INTEGER DEFAULT 1000,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- Create indexes for auth.api_keys
CREATE INDEX idx_api_keys_key_hash ON auth.api_keys(key_hash);
CREATE INDEX idx_api_keys_org_id ON auth.api_keys(org_id);
CREATE INDEX idx_api_keys_expires_at ON auth.api_keys(expires_at);

-- Query logs table
CREATE TABLE IF NOT EXISTS audit.query_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    query_id VARCHAR(255) UNIQUE NOT NULL,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES auth.api_keys(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    answer TEXT,
    sources JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    latency_ms INTEGER,
    tokens_used INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for audit.query_logs
CREATE INDEX idx_query_logs_org_id ON audit.query_logs(org_id);
CREATE INDEX idx_query_logs_api_key_id ON audit.query_logs(api_key_id);
CREATE INDEX idx_query_logs_created_at ON audit.query_logs(created_at);

-- Ingestion events table
CREATE TABLE IF NOT EXISTS audit.ingestion_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id VARCHAR(255) UNIQUE NOT NULL,
    source VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for audit.ingestion_events
CREATE INDEX idx_ingestion_events_source ON audit.ingestion_events(source);
CREATE INDEX idx_ingestion_events_status ON audit.ingestion_events(status);
CREATE INDEX idx_ingestion_events_org_id ON audit.ingestion_events(org_id);
CREATE INDEX idx_ingestion_events_created_at ON audit.ingestion_events(created_at);

-- Create update timestamp trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply update timestamp triggers
CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_documents_metadata_updated_at BEFORE UPDATE ON documents.metadata
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_keys_updated_at BEFORE UPDATE ON auth.api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default organization for development
INSERT INTO organizations (name, slug) 
VALUES ('Development Organization', 'dev-org')
ON CONFLICT (slug) DO NOTHING; 