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
        // Add Bearer token authentication for new endpoints
        cfg.headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
        // Keep legacy headers for backward compatibility
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
export type ChatMessageChunk = { type: 'content' | 'thinking' | 'unknown'; content: string } | {
  type: 'sources'; node: {
    sources: {
      id: string;
      title: string;
      source: string;
      url?: string;
      relevanceScore: number;
    };
  }
};

// Extensible chunk‑type detector stack
interface ChunkDetector { (raw: string, parsed: any): ChatMessageChunk | null; }
const detectors: ChunkDetector[] = [
  // Complete response in one go (new format)
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates' && typeof p[1] === 'object') {
      const nodeId: string = Object.keys(p[1])[0];
      if (nodeId === 'generate_rag' && p[1][nodeId].generatedText) {
        return { type: 'content', content: p[1][nodeId].generatedText };
      }
    }
    return null;
  },

  // LangGraph updates - sources
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId: string = Object.keys(p[1])[0];
      if (nodeId !== "doc_to_sources") return null;
      const node = p[1][nodeId];

      return { type: 'sources', node };
    }
    return null;
  },

  // LangGraph update - thinking
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId: string = Object.keys(p[1])[0];
      const node = p[1][nodeId];
      
      if (node.reasoning && Array.isArray(node.reasoning) && node.reasoning.length > 0) {
        return { type: 'thinking', content: node.reasoning[node.reasoning.length - 1] };
      }
    }
    return null;
  },
  
  // LangGraph messages node - content chunks
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'messages') {
      const details = p[1];
      if (Array.isArray(details) && details.length > 0 && details[0].kwargs?.content) {
        return { type: 'content', content: details[0].kwargs.content };
      }
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
  // Use cleaner, more standard websocket URL with no auth in query params
  // We'll handle auth in the connection headers and message
  // The correct WebSocket endpoint appears to be at /chat/ws based on the 404 error
  const wsUrl = cfg.baseUrl.replace(/^http/, 'ws') + `/chat/ws`;

  return new Promise((resolve, reject) => {
    // Add proper auth headers to match HTTP request pattern
    const wsOptions = {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'x-api-key': cfg.apiKey,
        'x-user-id': 'test-user-id'
      }
    };
    
    const ws = new WebSocket(wsUrl, wsOptions);
    let full = '';
    const log = (...a: any[]) => debug && console.log('[WS]', ...a);

    ws.on('open', () => {
      log('open');
      ws.send(JSON.stringify({
        userId: 'test-user-id',
        messages: [{ role: 'user', content: message, timestamp: Date.now() }],
        options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000, temperature: 0.7 },
        stream: true,
        auth: {
          token: cfg.apiKey
        }
      }));
    });

    ws.on('message', (buffer: Buffer) => {
      const raw = buffer.toString();
      // Debug: Log raw messages to understand format
      if (debug) console.log('[WS Debug] Raw message:', raw);
      
      const chunk = detectChunk(raw);
      if (debug) console.log('[WS Debug] Detected chunk type:', chunk.type);
      
      if (chunk.type === 'content') full += chunk.content;
      
      // Handle direct text response that might not fit detector patterns
      if (chunk.type === 'unknown' && chunk.content) {
        try {
          // Try to extract direct text content if possible
          const parsed = JSON.parse(chunk.content);
          if (parsed && typeof parsed === 'object') {
            // Check common response formats
            if (parsed.content) {
              chunk.type = 'content';
              chunk.content = parsed.content;
            } else if (parsed.message) {
              chunk.type = 'content';
              chunk.content = parsed.message;
            } else if (parsed.response) {
              chunk.type = 'content';
              chunk.content = parsed.response;
            }
          }
        } catch (e) {
          // Not JSON or not in expected format, keep as is
        }
      }
      
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
      if (opts.debug) {
        if (e instanceof Error) {
          console.log(`WebSocket error: ${e.message}`);
          if (e.stack) console.log(e.stack);
        } else {
          console.log(`WebSocket error: ${String(e)}`);
        }
      } else {
        console.log(`WebSocket connection failed, using HTTP fallback...`);
      }
      if (opts.retryNonStreaming !== false) {
        // Only show this message in debug mode
        if (opts.debug) {
          console.log('Falling back to HTTP request...');
        }
        try {
          // Fallback to blocking call
          const res = await api.post('/chat', {
            userId: 'test-user-id',
            messages: [{ role: 'user', content: message, timestamp: Date.now() }],
            options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000, temperature: 0.7 },
            stream: false,
            auth: {
              token: loadConfig().apiKey
            }
          });
          
          // Extract the response text
          const responseText = getResponseText(res);
          
          // Only log in debug mode
          if (opts.debug) {
            console.log('HTTP response received');
          }
          
          // Send the response as a string to the handler - only once
          onChunk?.(responseText);
          
          return { response: responseText, success: true, note: 'WS failed – HTTP fallback' };
        } catch (httpErr) {
          console.log(`HTTP fallback error: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`);
          throw httpErr;
        }
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
    auth: {
      token: loadConfig().apiKey
    }
  });
  return getResponseText(res);
}

// ---------- GitHub repository API functions -------------------------------------
/**
 * Register a GitHub repository in Dome
 * @param owner GitHub repository owner
 * @param repo GitHub repository name
 * @param cadence Optional sync cadence (default: 'PT1H' = hourly)
 * @returns Registration result
 */
async function registerGithubRepo(
  owner: string,
  repo: string,
  cadence: string = 'PT1H'
): Promise<{ success: boolean; id: string; resourceId: string; wasInitialised: boolean }> {
  return api.post('/content/github', {
    owner,
    repo,
    cadence
  });
}

/**
 * Get GitHub repository sync history
 * @param owner GitHub repository owner
 * @param repo GitHub repository name
 * @param limit Maximum number of history records to return
 * @returns Sync history
 */
async function getGithubRepoHistory(
  owner: string,
  repo: string,
  limit: number = 10
): Promise<{ success: boolean; owner: string; repo: string; resourceId: string; history: any[] }> {
  return api.get(`/content/github/${owner}/${repo}/history?limit=${limit}`);
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

// Export search functions
export { search as searchContent };
export { registerGithubRepo, getGithubRepoHistory };
