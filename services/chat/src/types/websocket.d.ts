/**
 * WebSocket event map type definitions for Cloudflare Workers
 */
interface WebSocketEventMap {
  close: CloseEvent;
  error: Event;
  message: MessageEvent;
  open: Event;
}

/**
 * Message event interface for WebSocket
 */
interface MessageEvent {
  readonly data: string | ArrayBuffer;
  readonly type: string;
  readonly target: EventTarget | null;
}

/**
 * Close event interface for WebSocket
 */
interface CloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly type: string;
  readonly target: EventTarget | null;
}

/**
 * Extended WebSocket interface that's compatible with Cloudflare Workers
 */
interface WebSocket extends EventTarget {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

// WebSocket connection states
interface WebSocketConstructor {
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  new (url: string, protocols?: string | string[]): WebSocket;
  readonly prototype: WebSocket;
}

declare var WebSocket: WebSocketConstructor;
