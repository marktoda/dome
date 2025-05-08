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
        // Remove hardcoded user ID to let the server resolve it from the token
      }
      return cfg;
    });
  }

  request<T = any>(
    method: 'get' | 'post' | 'put' | 'delete',
    url: string,
    dataOrCfg?: any,
    cfg?: AxiosRequestConfig,
  ) {
    return this.axios[method]<T>(url, dataOrCfg, cfg).then(r => r.data);
  }

  get = <T = any>(u: string, c?: AxiosRequestConfig) => this.request<T>('get', u, c);
  post = <T = any>(u: string, d?: any, c?: AxiosRequestConfig) => this.request<T>('post', u, d, c);
  put = <T = any>(u: string, d?: any, c?: AxiosRequestConfig) => this.request<T>('put', u, d, c);
  delete = <T = any>(u: string, c?: AxiosRequestConfig) => this.request<T>('delete', u, c);
}

// Singleton accessor -------------------------------------------------------------
let apiInstance: ApiClient; // lazy
const getApiInstance = () => (apiInstance ??= new ApiClient());
export const resetApiInstance = () => {
  apiInstance = undefined as any;
};

// Light backwards‑compat façade
export const api = {
  get: (u: string, c?: AxiosRequestConfig) => getApiInstance().get(u, c),
  post: (u: string, d?: any, c?: AxiosRequestConfig) => getApiInstance().post(u, d, c),
  put: (u: string, d?: any, c?: AxiosRequestConfig) => getApiInstance().put(u, d, c),
  delete: (u: string, c?: AxiosRequestConfig) => getApiInstance().delete(u, c),
};

// ---------- Convenience wrappers (unchanged signatures) -------------------------
export const addContent = (content: string, title?: string, tags?: string[]) =>
  api
    .post(
      '/notes',
      {
        content,
        mimeType: 'text/plain',
        title,
        metadata: tags ? { tags } : undefined,
      },
      {
        // Add extra protection against malformed JSON
        transformRequest: [
          (data, headers) => {
            if (headers) headers['Content-Type'] = 'application/json';
            // Use JSON.stringify directly to ensure proper escaping
            return JSON.stringify(data);
          },
        ],
      },
    )
    .then(r => r.note ?? r);

export const updateContent = (id: string, content: string, title?: string, tags?: string[]) => {
  // Basic content sanitization to prevent JSON parsing errors
  const sanitizeContent = (str: string) => {
    // Replace any characters that might cause issues in JSON
    // First, handle any invalid JSON escape sequences
    return str
      .replace(/\\/g, '\\\\') // Escape backslashes first
      .replace(/\n/g, '\\n') // Replace newlines with proper JSON newline escape
      .replace(/\r/g, '\\r') // Replace carriage returns
      .replace(/\t/g, '\\t') // Replace tabs
      .replace(/\f/g, '\\f') // Replace form feeds
      .replace(/"/g, '\\"'); // Escape quotes
  };

  // Let axios handle JSON serialization
  return api
    .put(
      `/notes/${id}`,
      {
        body: content,
        mimeType: 'text/plain',
        title,
        metadata: tags ? { tags } : undefined,
      },
      {
        // Add extra protection against malformed JSON
        transformRequest: [
          (data, headers) => {
            if (headers) headers['Content-Type'] = 'application/json';
            // Use JSON.stringify directly to ensure proper escaping
            return JSON.stringify(data);
          },
        ],
      },
    )
    .then(r => r.note ?? r);
};

export const addNote = (context: string, content: string) =>
  api.post(
    '/notes',
    {
      content,
      mimeType: 'text/plain',
      metadata: { context },
    },
    {
      // Add extra protection against malformed JSON
      transformRequest: [
        (data, headers) => {
          if (headers) headers['Content-Type'] = 'application/json';
          // Use JSON.stringify directly to ensure proper escaping
          return JSON.stringify(data);
        },
      ],
    },
  );

export const listItems = async (type: 'notes' | 'tasks', filter?: string) => {
  const params: Record<string, any> = { fields: 'title,summary,body,tags,contentType,createdAt' };
  if (filter)
    Object.assign(params, type === 'notes' ? { contentType: filter } : { status: filter });
  const res = await api.get(type === 'notes' ? '/notes' : '/tasks', { params });
  const items = res[type] ?? res.items ?? (Array.isArray(res) ? res : []);
  return { [type]: items, items, total: res.total ?? items.length };
};
export const listNotes = (f?: string) => listItems('notes', f);
export const listTasks = (f?: string) => listItems('tasks', f);
export const showItem = (id: string) => api.get(`/notes/${id}`).then(r => r.note ?? r);

export const search = async (query: string, limit = 10, category?: string) => {
  const params: Record<string, any> = {
    q: query,
    limit,
    fields: 'title,summary,body,tags,contentType,createdAt',
  };

  if (category) {
    params.category = category;
  }

  const res = await api.get('/search', { params });
  const results = (res.results ?? []).map((r: any) => ({ ...r, score: +r.score || 0 }));
  return {
    results,
    pagination: res.pagination ?? { total: 0, limit, offset: 0, hasMore: false },
    query,
    category,
  };
};

// ---------- Streaming / WebSocket chat -----------------------------------------
export type ChatMessageChunk =
  | { type: 'content' | 'thinking' | 'unknown'; content: string }
  | {
      type: 'sources';
      node: {
        sources: {
          id: string;
          title: string;
          source: string;
          url?: string;
          relevanceScore: number;
        };
      };
    };

// Extensible chunk‑type detector stack
interface ChunkDetector {
  (raw: string, parsed: any): ChatMessageChunk | null;
}
const detectors: ChunkDetector[] = [
  // LangGraph updates - sources
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId: string = Object.keys(p[1])[0];
      if (nodeId !== 'doc_to_sources') return null;
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
        const node = details[1].langgraph_node;
        if (node === 'generate_answer') {
          return { type: 'content', content: details[0].kwargs.content };
        }
      }
    }
    return null;
  },

  // Handle tasks object that contains a task query
  (raw, p) => {
    if (typeof p === 'object' && p.tasks && Array.isArray(p.tasks)) {
      if (p.instructions && typeof p.instructions === 'string') {
        return { type: 'thinking', content: p.instructions };
      }
      if (p.reasoning && typeof p.reasoning === 'string') {
        return { type: 'thinking', content: p.reasoning };
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
  } catch {
    /* fall‑through */
  }
  return { type: 'unknown', content: data };
};

export function connectWebSocketChat(
  messages: Array<{ role: string; content: string; timestamp: number }>,
  onChunk: (chunk: ChatMessageChunk) => void,
  { debug }: { debug?: boolean } = {},
): Promise<any> {
  const cfg = loadConfig();
  // Construct WebSocket URL with token in query parameter
  const token = cfg.apiKey;
  if (!token) {
    // This should ideally be caught by isAuthenticated() check before calling chat,
    // but as a safeguard:
    return Promise.reject(new Error('Authentication token not found. Please login.'));
  }
  const wsUrl = `${cfg.baseUrl.replace(/^http/, 'ws')}/chat/ws?token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    // Custom headers for WebSocket constructor are often not reliably passed or handled,
    // especially across different environments (Node.js ws vs browser WebSocket).
    // Authentication via query parameter during handshake is more standard.
    const ws = new WebSocket(wsUrl);
    let full = '';
    const log = (...a: any[]) => debug && console.debug('[WS]', ...a);

    ws.on('open', () => {
      log('open');
      ws.send(
        JSON.stringify({
          // Token is now sent in URL, no longer needed in payload.
          // User ID is resolved by the server from the token.
          messages: messages,
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
            temperature: 0.7,
          },
          stream: true,
          // No longer sending token or auth object in the message body
        }),
      );
    });

    ws.on('message', (buffer: Buffer) => {
      const raw = buffer.toString();
      const chunk = detectChunk(raw);

      if (chunk.type === 'content') full += chunk.content;

      // Handle direct text response that might not fit detector patterns
      if (chunk.type === 'unknown' && chunk.content) {
        // Skip printing raw JSON for recognized LangGraph message formats
        if (
          raw.startsWith('["messages"') ||
          raw.startsWith('["updates"') ||
          raw.includes('"generatedText"') ||
          raw.includes('"reasoning"')
        ) {
          if (debug) log('Skipping internal LangGraph format:', raw.substring(0, 50) + '...');
          return; // Skip this chunk as it's raw LangGraph metadata
        }
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
import { getChatSession } from './chatSession';

export async function chat(
  message: string,
  onChunk?: (c: string | ChatMessageChunk) => void,
  opts: { abortSignal?: AbortSignal; retryNonStreaming?: boolean; debug?: boolean } = {},
) {
  // Get the chat session and add the user message
  const session = getChatSession();
  session.addUserMessage(message);
  const messages = session.getMessages();

  if (onChunk) {
    try {
      const result = await connectWebSocketChat(messages, chunk => onChunk?.(chunk), opts);

      // If we got a successful response, add it to the session
      if (result && result.response) {
        session.addAssistantMessage(result.response);
      }

      return result;
    } catch (e) {
      if (opts.debug) {
        if (e instanceof Error) {
          console.debug(`WebSocket error: ${e.message}`);
          if (e.stack) console.debug(e.stack);
        } else {
          console.debug(`WebSocket error: ${String(e)}`);
        }
      } else {
        console.debug(`WebSocket connection failed, using HTTP fallback...`);
      }
      if (opts.retryNonStreaming !== false) {
        // Only show this message in debug mode
        if (opts.debug) {
          console.debug('Falling back to HTTP request...');
        }
        try {
          // Fallback to blocking call
          const res = await api.post('/chat', {
            // Use all messages from the session
            messages: messages,
            options: {
              enhanceWithContext: true,
              maxContextItems: 5,
              includeSourceInfo: true,
              maxTokens: 1000,
              temperature: 0.7,
            },
            stream: false,
            // Token is now handled by the ApiClient interceptor via Authorization header
            // Remove token and auth from the body
          });

          // Extract the response text
          const responseText = getResponseText(res);

          // Add the assistant's response to the session
          session.addAssistantMessage(responseText);

          // Only log in debug mode
          if (opts.debug) {
            console.debug('HTTP response received');
          }

          // Send the response as a content chunk rather than raw string
          onChunk?.({ type: 'content', content: responseText });

          return { response: responseText, success: true, note: 'WS failed – HTTP fallback' };
        } catch (httpErr) {
          if (opts.debug) {
            console.debug(
              `HTTP fallback error: ${
                httpErr instanceof Error ? httpErr.message : String(httpErr)
              }`,
            );
          }
          throw httpErr;
        }
      }
      throw e;
    }
  }
  // non‑streaming path
  const res = await api.post('/chat', {
    // Use all messages from the session
    messages: messages,
    options: {
      enhanceWithContext: true,
      maxContextItems: 5,
      includeSourceInfo: true,
      maxTokens: 1000,
      temperature: 0.7,
    },
    stream: false,
    // Token is now handled by the ApiClient interceptor via Authorization header
    // Remove token and auth from the body
  });

  const responseText = getResponseText(res);

  // Add the assistant's response to the session
  session.addAssistantMessage(responseText);

  return responseText;
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
  cadence: string = 'PT1H',
): Promise<{ success: boolean; id: string; resourceId: string; wasInitialised: boolean }> {
  return api.post('/content/github', {
    owner,
    repo,
    cadence,
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
  limit: number = 10,
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

