import WebSocket from 'ws';
import EventEmitter from 'events';

/**
 * A single chunk coming from the dome /chat/ws streaming endpoint.
 */
export interface ChatMessageChunk {
  type: 'thinking' | 'content' | 'sources' | 'error' | 'end';
  content?: string;
  // `sources` field is an array when type === 'sources'
  sources?: Array<{
    id: string;
    title: string;
    type: string;
    url?: string;
    [key: string]: unknown;
  }>;
  error?: {
    message: string;
    code?: string;
  };
}

export interface ChatWebSocketOptions {
  /** Log raw frames + lifecycle events */
  verbose?: boolean;
}

// ---------- Detector helpers to translate LangGraph stream into ChatMessageChunk ----------
type AnyJson = any;
type DetectorFn = (raw: string, parsed: AnyJson) => ChatMessageChunk | null;

const detectors: DetectorFn[] = [
  // Sources emitted from doc_to_sources
  (_raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId: string = Object.keys(p[1])[0];
      if (nodeId !== 'doc_to_sources') return null;
      const node = p[1][nodeId];
      return { type: 'sources', sources: node.sources ?? [] } as any;
    }
    return null;
  },
  // Thinking / reasoning strings
  (_raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId = Object.keys(p[1])[0];
      const node = p[1][nodeId];
      if (node?.reasoning) {
        const last = Array.isArray(node.reasoning) ? node.reasoning[node.reasoning.length - 1] : node.reasoning;
        if (typeof last === 'string') return { type: 'thinking', content: last };
      }
    }
    return null;
  },
  // Content chunks from generate_answer
  (_raw, p) => {
    if (Array.isArray(p) && p[0] === 'messages') {
      const details = p[1];
      if (Array.isArray(details) && details.length > 0) {
        const first = details[0];
        const contentStr = first?.kwargs?.content;
        const nodeName = details[1]?.langgraph_node;
        if (contentStr && nodeName === 'generate_answer') {
          return { type: 'content', content: contentStr };
        }
      }
    }
    return null;
  },
  // Tasks structure
  (_raw, p) => {
    if (p && p.tasks && Array.isArray(p.tasks)) {
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

function detectChunk(raw: string, parsed: AnyJson): ChatMessageChunk | null {
  for (const det of detectors) {
    const res = det(raw, parsed);
    if (res) return res;
  }
  return null;
}

/**
 * Minimal wrapper around the websocket streaming endpoint that normalises the
 * different possible `event.data` shapes and emits parsed {@link ChatMessageChunk}s.
 *
 * Usage:
 * ```ts
 * const client = new ChatWebSocketClient(wsUrl, payload, { verbose: true });
 * client.on('chunk', chunk => { ... })
 * client.on('error', err => { ... })
 * client.on('close', () => { ... })
 * ```
 */
export class ChatWebSocketClient extends EventEmitter {
  private ws: WebSocket;
  private td = new TextDecoder();
  private verbose: boolean;
  private buffer = '';

  constructor(wsUrl: string, requestPayload: unknown, opts: ChatWebSocketOptions = {}) {
    super();
    this.verbose = !!opts.verbose;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.debug('connection established');
      this.ws.send(JSON.stringify(requestPayload));
    };

    this.ws.onmessage = (evt: WebSocket.MessageEvent) => {
      this.handleIncoming(evt);
    };

    this.ws.onerror = (evt: WebSocket.ErrorEvent) => {
      const error = new Error(`WebSocket error: ${evt.message}`);
      this.emit('error', error);
    };

    this.ws.onclose = (evt: WebSocket.CloseEvent) => {
      this.debug(`connection closed (${evt.code})`);
      this.emit('close', evt);
    };
  }

  /** Close underlying websocket */
  public close(): void {
    this.ws.close();
  }

  private handleIncoming(event: WebSocket.MessageEvent): void {
    if (typeof event.data === 'string') {
      this.debug(`incoming string (${event.data.length} bytes)`);
      this.processChunk(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      this.debug(`incoming ArrayBuffer (${event.data.byteLength} bytes)`);
      this.processChunk(this.td.decode(event.data));
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(event.data)) {
      this.debug(`incoming Buffer (${event.data.length} bytes)`);
      this.processChunk(event.data.toString('utf-8'));
    } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
      event.data.text().then(txt => this.processChunk(txt)).catch(err => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    } else if (typeof event.data === 'object' && event.data !== null) {
      // Fallback – try stringify then parse
      try {
        this.processChunk(JSON.stringify(event.data));
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      this.emit('error', new Error('Unsupported WebSocket message format'));
    }
  }

  private processChunk(raw: string): void {
    // Detailed raw-frame debug disabled to reduce noise; enable if needed.

    // Try to parse the raw chunk directly (normal case: one JSON per frame)
    try {
      const parsedAny = JSON.parse(raw);
      const mapped = detectChunk(raw, parsedAny);
      if (mapped) {
        this.debug(`parsed chunk mapped type=${mapped.type}`);
        this.emit('chunk', mapped);
        if (mapped.type === 'end') this.close();
        return;
      }
    } catch {
      this.debug('frame was not standalone JSON, buffering...');
    }

    // Accumulate and process newline-delimited fragments (fallback for partial frames)
    this.buffer += raw;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const parsedAny = JSON.parse(line);
        const mapped = detectChunk(line, parsedAny);
        if (mapped) {
          this.debug(`parsed buffered line mapped type=${mapped.type}`);
          this.emit('chunk', mapped);
          if (mapped.type === 'end') this.close();
        }
      } catch {/* ignore until we have full line */}
    }
  }

  private debug(msg: string): void {
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.log(`[WS] ${msg}`);
    }
  }
} 