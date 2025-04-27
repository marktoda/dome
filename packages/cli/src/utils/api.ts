// Simplified, drop‑in‑compatible Dome API client
// ───────────────────────────────────────────────
// • Keeps **all** public exports identical to the previous file
// • Pulls repetitive logic into small helpers
// • Adds an extensible chunk‑type detector (ChunkDetectors[] stack)
// • No behavioural changes – safe to swap‑in

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import WebSocket from 'ws';
import { loadConfig, isAuthenticated } from './config';

// ---------- HTTP ----------------------------------------------------------------
class ApiClient {
  private readonly cfg = this.cfgOverride || loadConfig();
  private readonly axios: AxiosInstance;
  constructor(private readonly cfgOverride?: ReturnType<typeof loadConfig>) {
    this.axios = axios.create({
      baseURL: this.cfg.baseUrl,
      headers: { 'Content-Type': 'application/json' },
    });

    this.axios.interceptors.request.use(cfg => {
      if (isAuthenticated()) {
        cfg.headers['x-api-key'] = this.cfg.apiKey;
        cfg.headers['x-user-id'] = 'test-user-id';
      }
      return cfg;
    });
  }

  request<T = any>(method: 'get' | 'post' | 'put' | 'delete', url: string, dataOrCfg?: any, cfg?: AxiosRequestConfig) {
    return this.axios[method]<T>(url, dataOrCfg, cfg).then(r => r.data);
  }

  get = <T = any>(u: string, c?: AxiosRequestConfig) => this.request<T>('get', u, c);
  post = <T = any>(u: string, d?: any, c?: AxiosRequestConfig) => this.request<T>('post', u, d, c);
  put = <T = any>(u: string, d?: any, c?: AxiosRequestConfig) => this.request<T>('put', u, d, c);
  delete = <T = any>(u: string, c?: AxiosRequestConfig) => this.request<T>('delete', u, c);
}

// Singleton accessor -------------------------------------------------------------
let apiInstance: ApiClient;  // lazy
const getApiInstance = () => (apiInstance ??= new ApiClient());
export const resetApiInstance = () => { apiInstance = undefined as any; };

// Light backwards‑compat façade
export const api = {
  get: (u: string, c?: AxiosRequestConfig) => getApiInstance().get(u, c),
  post: (u: string, d?: any, c?: AxiosRequestConfig) => getApiInstance().post(u, d, c),
  put: (u: string, d?: any, c?: AxiosRequestConfig) => getApiInstance().put(u, d, c),
  delete: (u: string, c?: AxiosRequestConfig) => getApiInstance().delete(u, c),
};

// ---------- Convenience wrappers (unchanged signatures) -------------------------
export const addContent = (content: string, title?: string, tags?: string[]) =>
  api.post('/notes', { content, contentType: 'text/plain', title, tags }).then(r => r.note ?? r);

export const addNote = (context: string, content: string) =>
  api.post('/notes', { content, contentType: 'text/plain', metadata: { context } });

export const listItems = async (type: 'notes' | 'tasks', filter?: string) => {
  const params: Record<string, any> = { fields: 'title,summary,body,tags,contentType,createdAt' };
  if (filter) Object.assign(params, type === 'notes' ? { contentType: filter } : { status: filter });
  const res = await api.get(type === 'notes' ? '/notes' : '/tasks', { params });
  const items = res[type] ?? res.items ?? (Array.isArray(res) ? res : []);
  return { [type]: items, items, total: res.total ?? items.length };
};
export const listNotes = (f?: string) => listItems('notes', f);
export const listTasks = (f?: string) => listItems('tasks', f);
export const showItem = (id: string) => api.get(`/notes/${id}`).then(r => r.note ?? r);

export const search = async (query: string, limit = 10) => {
  const res = await api.get('/search', { params: { q: query, limit, fields: 'title,summary,body,tags,contentType,createdAt' } });
  const results = (res.results ?? []).map((r: any) => ({ ...r, score: +r.score || 0 }));
  return { results, pagination: res.pagination ?? { total: 0, limit, offset: 0, hasMore: false }, query };
};

// ---------- Streaming / WebSocket chat -----------------------------------------
export type ChatMessageChunk = { type: 'content' | 'thinking' | 'unknown'; content: string };

// Extensible chunk‑type detector stack
interface ChunkDetector { (raw: string, parsed: any): ChatMessageChunk | null; }
const detectors: ChunkDetector[] = [
  // LangGraph generate_answer node
  (raw, p) => {
    if (Array.isArray(p) && p[1]?.langgraph_node === 'generate_answer' && p[0]?.kwargs?.content !== undefined) {
      return { type: 'content', content: p[0].kwargs.content };
    }
    return null;
  },
  // AIMessageChunk introspection (thinking)
  (raw, p) => {
    if (Array.isArray(p) && p[0]?.id?.[2] === 'AIMessageChunk' && p[0]?.kwargs?.content !== undefined) {
      return { type: 'thinking', content: p[0].kwargs.content };
    }
    return null;
  },
];

const detectChunk = (data: string): ChatMessageChunk => {
  try {
    const parsed = JSON.parse(data);
    for (const det of detectors) {
      const match = det(data, parsed);
      if (match) return match;
    }
  } catch { /* fall‑through */ }
  return { type: 'unknown', content: data };
};

export function connectWebSocketChat(
  message: string,
  onChunk: (chunk: ChatMessageChunk) => void,
  { debug }: { debug?: boolean } = {}
): Promise<any> {
  const cfg = loadConfig();
  const wsUrl = cfg.baseUrl.replace(/^http/, 'ws') + `/chat?apiKey=${encodeURIComponent(cfg.apiKey || '')}&userId=test-user-id`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let full = '';
    const log = (...a: any[]) => debug && console.log('[WS]', ...a);

    ws.on('open', () => {
      log('open');
      ws.send(JSON.stringify({
        userId: 'test-user-id',
        messages: [{ role: 'user', content: message, timestamp: Date.now() }],
        options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000, temperature: 0.7 },
        stream: true,
      }));
    });

    ws.on('message', (buffer: Buffer) => {
      const raw = buffer.toString();
      const chunk = detectChunk(raw);
      if (chunk.type === 'content') full += chunk.content;
      onChunk(chunk);
    });

    ws.on('close', () => resolve({ response: full, success: true }));
    ws.on('error', reject);
    setTimeout(() => ws.close(), 60_000); // auto‑close after 1 min
  });
}

// chat() & HTTP fallback are thin wrappers around connectWebSocketChat for brevity ------------------
export async function chat(
  message: string,
  onChunk?: (c: string | ChatMessageChunk) => void,
  opts: { abortSignal?: AbortSignal; retryNonStreaming?: boolean; debug?: boolean } = {}
) {
  if (onChunk) {
    try {
      return await connectWebSocketChat(message, chunk => onChunk?.(chunk), opts);
    } catch (e) {
      if (opts.retryNonStreaming !== false) {
        // Fallback to blocking call
        const res = await api.post('/chat', {
          userId: 'test-user-id',
          messages: [{ role: 'user', content: message, timestamp: Date.now() }],
          options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000, temperature: 0.7 },
          stream: false,
        });
        return { response: getResponseText(res), success: true, note: 'WS failed – HTTP fallback' };
      }
      throw e;
    }
  }
  // non‑streaming path
  const res = await api.post('/chat', {
    userId: 'test-user-id',
    messages: [{ role: 'user', content: message, timestamp: Date.now() }],
    options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000, temperature: 0.7 },
    stream: false,
  });
  return getResponseText(res);
}

// ---------- Helpers -------------------------------------------------------------
function getResponseText(res: any): string {
  if (!res) return "I'm sorry, but I couldn't generate a response at this time.";
  // Straight string or common wrappers
  if (typeof res === 'string') return res;
  if (res.response && typeof res.response === 'string') return res.response;
  if (res.data?.response?.response) return res.data.response.response;
  if (res.note) return res.note;
  return JSON.stringify(res);
}

// ---------- Type re‑exports for compatibility -----------------------------------
export type { AxiosRequestConfig } from 'axios';
