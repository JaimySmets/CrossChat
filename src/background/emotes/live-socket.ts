// A self-healing WebSocket for the live emote feeds (7TV EventAPI, BTTV).
// Same lifecycle rules as the IRC source: exponential backoff on close, a
// per-socket AbortController so a replaced socket's listeners can't schedule a
// reconnect behind us, and an optional silence watchdog for half-open sockets.

const MAX_BACKOFF_MS = 60_000;

export interface LiveSocketHandlers {
  /** Socket is open. `reconnected` is true on every open after the first. */
  onOpen(reconnected: boolean): void;
  onMessage(data: string): void;
}

export class LiveSocket {
  private ws: WebSocket | null = null;
  private abort: AbortController | null = null;
  private stopped = true;
  private opened = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  /** Silence after which the socket counts as dead; 0 = no watchdog. */
  private deadAfterMs = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: LiveSocketHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.teardown();
  }

  /** Drop the current socket and reconnect now (server asked, or watchdog). */
  reconnect(): void {
    if (this.stopped) return;
    this.backoff = 1000;
    this.open();
  }

  /**
   * Enable the silence watchdog. Only for feeds with app-level heartbeats:
   * browsers hide WebSocket ping frames, so a quiet-but-healthy socket without
   * them would be torn down for nothing.
   */
  setDeadAfter(ms: number): void {
    this.deadAfterMs = ms;
    this.startWatchdog();
  }

  /** OS network hint from the content script (see TwitchIrcSource). */
  setNetworkOnline(online: boolean): void {
    if (this.stopped) return;
    if (online) {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      this.reconnect();
    } else {
      this.teardown();
      this.scheduleReconnect();
    }
  }

  send(payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      /* socket transitioning; the close path reconnects */
    }
  }

  private open(): void {
    this.clearReconnect();
    this.teardown();
    const abort = new AbortController();
    this.abort = abort;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const signal = abort.signal;

    ws.addEventListener(
      "open",
      () => {
        this.backoff = 1000;
        this.lastActivity = Date.now();
        this.startWatchdog();
        const reconnected = this.opened;
        this.opened = true;
        this.handlers.onOpen(reconnected);
      },
      { signal },
    );
    ws.addEventListener(
      "message",
      (ev) => {
        this.lastActivity = Date.now();
        this.handlers.onMessage(String(ev.data));
      },
      { signal },
    );
    ws.addEventListener("close", () => this.scheduleReconnect(), { signal });
    ws.addEventListener("error", () => ws.close(), { signal });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.teardown();
    this.clearReconnect();
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    if (!this.deadAfterMs || this.ws?.readyState !== WebSocket.OPEN) return;
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity >= this.deadAfterMs) this.reconnect();
    }, Math.min(15_000, this.deadAfterMs));
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Close the current socket without letting its listeners reconnect. */
  private teardown(): void {
    this.stopWatchdog();
    this.abort?.abort();
    this.abort = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }
}
