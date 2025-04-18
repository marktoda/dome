import { Bindings } from '../types'
import { ServiceError } from '@dome/common'

/* -------------------------------------------------------------------------- */
/*                                  TYPES                                     */
/* -------------------------------------------------------------------------- */

export interface VectorMetadata {
  userId: string
  noteId: string
  createdAt: number
  pageNum?: number
}

export interface SearchResult {
  id: string
  score: number
  metadata: VectorMetadata
}

interface VectorizeVector<M = Record<string, unknown>> {
  id: string
  values: number[]
  metadata?: M
}

/* -------------------------------------------------------------------------- */
/*                               CONSTANTS                                    */
/* -------------------------------------------------------------------------- */

const INDEX_DIMENSION = 768

/* -------------------------------------------------------------------------- */
/*                              ERROR HELPER                                  */
/* -------------------------------------------------------------------------- */

const err = (msg: string, ctx: Record<string, unknown>, cause: unknown) =>
  new ServiceError(msg, {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
    context: ctx,
  })

/* -------------------------------------------------------------------------- */
/*                                SERVICE                                      */
/* -------------------------------------------------------------------------- */

export class VectorizeService {
  private idx(env: Bindings) {
    if (!env.VECTORIZE) throw new ServiceError('VECTORIZE binding missing')
    return env.VECTORIZE as any // cast until types include vector param
  }

  /* core wrappers */
  private async _insert(env: Bindings, v: VectorizeVector<VectorMetadata>) {
    await this.idx(env).insert([v])
  }
  private async _upsert(env: Bindings, v: VectorizeVector<VectorMetadata>) {
    await this.idx(env).upsert([v])
  }
  private async _delete(env: Bindings, id: string) {
    await this.idx(env).delete([id])
  }
  private async _query(env: Bindings, vector: number[], topK: number, filter?: any) {
    const res = await this.idx(env).query(vector, { topK, filter })
    return res.matches as Array<{ id: string; score: number; metadata: any }>
  }

  /* ------------------------- PUBLIC (compat) ------------------------- */
  async addVector(env: Bindings, id: string, vector: number[], metadata: VectorMetadata) {
    try {
      await this._insert(env, { id, values: vector, metadata })
    } catch (e) { throw err('addVector failed', { id }, e) }
  }

  async updateVector(env: Bindings, id: string, vector: number[], metadata: VectorMetadata) {
    try {
      await this._upsert(env, { id, values: vector, metadata })
    } catch (e) { throw err('updateVector failed', { id }, e) }
  }

  async deleteVector(env: Bindings, id: string) {
    try { await this._delete(env, id) } catch (e) { throw err('deleteVector failed', { id }, e) }
  }

  async queryVectors(
    env: Bindings,
    vector: number[],
    options: { topK?: number; filter?: Partial<VectorMetadata> } = {},
  ): Promise<SearchResult[]> {
    const { topK = 10, filter } = options
    try {
      const matches = await this._query(env, vector, topK, filter as any)
      return matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata as VectorMetadata }))
    } catch (e) { throw err('queryVectors failed', { options }, e) }
  }

  async getVectorsByIds(env: Bindings, ids: string[]) {
    const out = new Map<string, { metadata: VectorMetadata }>()
    const dummy = new Array(INDEX_DIMENSION).fill(0)
    const batch = 20
    for (let i = 0; i < ids.length; i += batch) {
      const slice = ids.slice(i, i + batch)
      await Promise.all(slice.map(async (id) => {
        try {
          const m = await this._query(env, dummy, 1, { id })
          if (m.length) out.set(id, { metadata: m[0].metadata as VectorMetadata })
        } catch (_) { }
      }))
    }
    return out
  }

  async listVectors(
    env: Bindings,
    filter: Partial<VectorMetadata> = {},
    options: { limit?: number; cursor?: string } = {},
  ) {
    const { limit = 100 } = options
    const dummy = new Array(INDEX_DIMENSION).fill(0)
    try {
      const matches = await this._query(env, dummy, limit, filter as any)
      return { vectors: matches.map((m) => ({ id: m.id, metadata: m.metadata as VectorMetadata })), cursor: undefined }
    } catch (e) { throw err('listVectors failed', { filter, options }, e) }
  }

  /* shorter aliases */
  insert = this.addVector.bind(this)
  upsert = this.updateVector.bind(this)
  remove = this.deleteVector.bind(this)
  query = this.queryVectors.bind(this)
  getByIds = this.getVectorsByIds.bind(this)
  list = this.listVectors.bind(this)
}

export const vectorizeService = new VectorizeService()
