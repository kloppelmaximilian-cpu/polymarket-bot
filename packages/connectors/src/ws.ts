import WebSocket from 'ws';

export type SocketState = 'IDLE' | 'CONNECTING' | 'OPEN' | 'CLOSED';

export interface ResilientSocketOptions {
  url: string;
  name: string;
  onMessage: (data: unknown) => void;
  onOpen?: (send: (payload: string) => void) => void;
  onStateChange?: (state: SocketState, detail?: string) => void;
  /** Reconnect when nothing arrived for this long, even if the socket looks open. */
  staleAfterMs: number;
  pingIntervalMs?: number;
  pingPayload?: string;
  maxBackoffMs?: number;
  /** For tests. */
  createSocket?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
  on(event: 'open' | 'close' | 'error' | 'message', listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?: () => void;
}

/**
 * A websocket that does not give up: exponential reconnect with jitter, a
 * watchdog that treats a silent-but-open socket as dead, optional
 * application-level pings, and JSON parsing that never throws into the
 * caller (malformed frames are counted, not fatal).
 */
export class ResilientSocket {
  private ws: WebSocketLike | null = null;
  private state: SocketState = 'IDLE';
  private attempts = 0;
  private lastMessageAt = 0;
  private stopped = true;
  private watchdog: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  malformed = 0;
  messages = 0;

  constructor(private readonly o: ResilientSocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), Math.max(1000, Math.floor(this.o.staleAfterMs / 3)));
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.watchdog, this.pinger]) if (t) clearInterval(t);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = this.pinger = this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.setState('CLOSED', 'stopped');
  }

  getState(): SocketState {
    return this.state;
  }

  lastMessage(): number {
    return this.lastMessageAt;
  }

  private setState(s: SocketState, detail?: string): void {
    this.state = s;
    this.o.onStateChange?.(s, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState('CONNECTING');
    const ws = this.o.createSocket ? this.o.createSocket(this.o.url) : (new WebSocket(this.o.url, { handshakeTimeout: 10_000 }) as unknown as WebSocketLike);
    this.ws = ws;
    ws.on('open', () => {
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.setState('OPEN');
      this.o.onOpen?.((p) => ws.send(p));
      if (this.o.pingIntervalMs && this.o.pingPayload) {
        if (this.pinger) clearInterval(this.pinger);
        this.pinger = setInterval(() => {
          try {
            ws.send(this.o.pingPayload!);
          } catch {
            /* reconnect logic handles it */
          }
        }, this.o.pingIntervalMs);
      }
    });
    ws.on('message', (raw: unknown) => {
      this.lastMessageAt = Date.now();
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (text === 'PONG' || text === 'pong') return;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        this.malformed++;
        return;
      }
      this.messages++;
      try {
        this.o.onMessage(data);
      } catch {
        this.malformed++;
      }
    });
    ws.on('error', (err: unknown) => this.setState(this.state, `error: ${(err as Error)?.message ?? String(err)}`));
    ws.on('close', () => {
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = null;
      if (this.ws !== ws) return;
      this.setState('CLOSED', 'closed');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts++;
    const delay = Math.min(this.o.maxBackoffMs ?? 60_000, 1000 * 2 ** Math.min(this.attempts - 1, 6)) + Math.floor(Math.random() * 500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private checkStale(): void {
    if (this.stopped || this.state !== 'OPEN') return;
    if (Date.now() - this.lastMessageAt > this.o.staleAfterMs) {
      this.setState('CLOSED', 'stale: no messages');
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.terminate ? ws.terminate() : ws?.close();
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    }
  }
}
