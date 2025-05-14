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
      this.processChunk(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      this.processChunk(this.td.decode(event.data));
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
    this.debug(`raw chunk: ${raw.substring(0, 120)}`);
    try {
      const parsed: ChatMessageChunk = JSON.parse(raw);
      this.emit('chunk', parsed);
      if (parsed.type === 'end') {
        this.close();
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private debug(msg: string): void {
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.log(`[WS] ${msg}`);
    }
  }
} 