// Twitch read via anonymous IRC-over-WebSocket (ARCHITECTURE.md §11.2).
// No OAuth: log in as justinfan<random>, JOIN the channel, parse tagged
// PRIVMSGs into NormalizedMessage. Native Twitch emotes are split out here
// from the IRCv3 `emotes` tag; 7TV/BTTV/FFZ are layered on later by the
// Emote Registry. Sits behind ChatSource so EventSub can replace it later.
//
// Note: MV3 service workers stay alive while a WebSocket is active (Chrome
// 116+), so this socket can live in the worker as the architecture intends.
import type {
  Badge,
  ChatSource,
  ConnectionState,
  Fragment,
  NormalizedMessage,
  ResolvedChannel,
} from "../../shared/types";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const EMOTE_CDN = "https://static-cdn.jtvnw.net/emoticons/v2";
const MAX_BACKOFF_MS = 30_000;

// Liveness watchdog. A dropped/restored network can leave the WebSocket in a
// half-open "zombie" state: TCP never got a reset, so no close/error event
// fires and readyState stays OPEN while messages silently stop. Twitch sends
// its own PING every ~5min, so any healthy socket sees traffic well inside
// DEAD_MS; prolonged silence means the socket is dead and must be rebuilt.
const HEARTBEAT_MS = 15_000; // watchdog tick
const PING_AFTER_MS = 30_000; // silence before we probe the server with a PING
const DEAD_MS = 60_000; // silence (incl. no PONG) => zombie socket, force reconnect

export class TwitchIrcSource implements ChatSource {
  readonly platform = "twitch" as const;

  private ws: WebSocket | null = null;
  private channel: ResolvedChannel | null = null;
  private intentionalClose = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  private lastActivity = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Aborted on teardown to detach a dead socket's listeners in one shot, so a
  // zombie we replace can't also fire close -> scheduleReconnect behind us.
  private socketAbort: AbortController | null = null;

  private messageCb: (msg: NormalizedMessage) => void = () => {};
  private stateCb: (s: ConnectionState) => void = () => {};

  onMessage(cb: (msg: NormalizedMessage) => void): void {
    this.messageCb = cb;
  }
  onState(cb: (s: ConnectionState) => void): void {
    this.stateCb = cb;
  }

  connect(channel: ResolvedChannel): Promise<void> {
    this.channel = channel;
    this.intentionalClose = false;
    this.open();
    return Promise.resolve();
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownSocket();
    this.stateCb({ status: "disconnected" });
  }

  private open(): void {
    if (!this.channel) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this.stateCb(this.attempt === 0 ? { status: "connecting" } : { status: "reconnecting", attempt: this.attempt });

    const abort = new AbortController();
    this.socketAbort = abort;
    const ws = new WebSocket(IRC_URL);
    this.ws = ws;

    ws.addEventListener(
      "open",
      () => {
        const nick = `justinfan${Math.floor(Math.random() * 90000) + 10000}`;
        ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        ws.send(`NICK ${nick}`);
        ws.send(`JOIN #${this.channel!.login}`);
        this.attempt = 0;
        this.backoff = 1000;
        this.markActivity();
        this.startHeartbeat();
        this.stateCb({ status: "connected" });
      },
      { signal: abort.signal },
    );

    ws.addEventListener(
      "message",
      (ev) => {
        this.markActivity();
        for (const line of String(ev.data).split("\r\n")) {
          if (line) this.handleLine(line);
        }
      },
      { signal: abort.signal },
    );

    ws.addEventListener("close", () => this.scheduleReconnect(), { signal: abort.signal });
    ws.addEventListener("error", () => ws.close(), { signal: abort.signal });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.attempt += 1;
    this.stateCb({ status: "reconnecting", attempt: this.attempt });
    const delay = Math.min(this.backoff, MAX_BACKOFF_MS);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private markActivity(): void {
    this.lastActivity = Date.now();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this.lastActivity;
      if (idle >= DEAD_MS) {
        // Silent past the point a healthy socket would have seen server traffic
        // (or our own PONG) — treat it as a zombie and rebuild immediately.
        this.attempt += 1;
        this.backoff = 1000;
        this.open();
        return;
      }
      if (idle >= PING_AFTER_MS) {
        // Probe: Twitch replies PONG, which lands as a message and refreshes
        // lastActivity. No reply within DEAD_MS trips the branch above.
        try {
          ws.send("PING :cross-chat");
        } catch {
          /* socket transitioning; the watchdog/close path will handle it */
        }
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Tear down the current socket without letting its listeners reconnect. */
  private teardownSocket(): void {
    this.stopHeartbeat();
    this.socketAbort?.abort();
    this.socketAbort = null;
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

  /**
   * React to an OS network transition (detected in the content script, since
   * the service worker doesn't fire reliable online/offline events) instead of
   * only waiting out the liveness watchdog. Offline surfaces the drop at once
   * (the socket is dead even if it hasn't fired a close yet); online retries
   * immediately rather than sitting out the backoff.
   */
  setNetworkOnline(online: boolean): void {
    if (this.intentionalClose || !this.channel) return;
    if (online) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      this.backoff = 1000;
      this.open(); // clears any pending reconnect timer, then connects now
    } else {
      // Network gone: drop the (now-dead) socket and show reconnecting right
      // away. scheduleReconnect keeps retrying with backoff as a backstop; the
      // next online hint short-circuits it the moment connectivity returns.
      this.teardownSocket();
      this.scheduleReconnect();
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith("PING")) {
      this.ws?.send("PONG" + line.slice(4));
      return;
    }
    const parsed = parseIrcLine(line);
    if (!parsed || parsed.command !== "PRIVMSG") return;

    const text = parsed.trailing ?? "";
    const tags = parsed.tags;
    const login = parsed.prefix?.split("!")[0] ?? "unknown";

    const msg: NormalizedMessage = {
      id: tags["id"] || crypto.randomUUID(),
      author: {
        displayName: tags["display-name"] || login,
        color: tags["color"] || undefined,
        badges: parseBadges(tags["badges"], tags["badge-info"]),
      },
      fragments: buildFragments(text, tags["emotes"]),
      timestamp: tags["tmi-sent-ts"] ? Number(tags["tmi-sent-ts"]) : Date.now(),
      platform: "twitch",
    };
    this.messageCb(msg);
  }
}

// --- IRC parsing helpers ---------------------------------------------------

interface ParsedLine {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
  trailing?: string;
}

export function parseIrcLine(line: string): ParsedLine | null {
  let rest = line;
  const tags: Record<string, string> = {};

  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const pair of tagStr.split(";")) {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const val = eq === -1 ? "" : pair.slice(eq + 1);
      tags[key] = unescapeTag(val);
    }
  }

  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  let trailing: string | undefined;
  const tIdx = rest.indexOf(" :");
  if (tIdx !== -1) {
    trailing = rest.slice(tIdx + 2);
    rest = rest.slice(0, tIdx);
  }

  const parts = rest.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  return { tags, prefix, command: parts[0], params: parts.slice(1), trailing };
}

function unescapeTag(v: string): string {
  return v
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function parseBadges(raw: string | undefined, info: string | undefined): Badge[] {
  if (!raw) return [];
  // `badge-info` carries true tenure (e.g. subscriber months), separate from the
  // `badges` version number which only selects the badge image tier.
  const tenure = parseBadgeInfo(info);
  return raw.split(",").map((b) => {
    const [id, version] = b.split("/");
    const badge: Badge = { id }; // image URLs resolved later (badge registry), else a chip
    if (version) badge.version = version;
    if (tenure[id] !== undefined) badge.count = tenure[id];
    return badge;
  });
}

/** Parse the `badge-info` tag (`subscriber/15,...`) into id → numeric tenure. */
function parseBadgeInfo(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [id, val] = part.split("/");
    const n = Number(val);
    if (id && Number.isFinite(n)) out[id] = n;
  }
  return out;
}

/**
 * Split message text into text + native-emote fragments using the IRCv3
 * `emotes` tag. Positions are Unicode code-point indices, so we index over a
 * code-point array to stay correct across surrogate pairs.
 */
export function buildFragments(text: string, emotesTag: string | undefined): Fragment[] {
  if (!emotesTag) return text ? [{ type: "text", value: text }] : [];

  const chars = Array.from(text);
  interface Span { start: number; end: number; id: string }
  const spans: Span[] = [];
  for (const group of emotesTag.split("/")) {
    const [id, ranges] = group.split(":");
    if (!id || !ranges) continue;
    for (const range of ranges.split(",")) {
      const [s, e] = range.split("-").map(Number);
      if (Number.isInteger(s) && Number.isInteger(e)) spans.push({ start: s, end: e, id });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  const out: Fragment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      const value = chars.slice(cursor, span.start).join("");
      if (value) out.push({ type: "text", value });
    }
    const name = chars.slice(span.start, span.end + 1).join("");
    out.push({
      type: "emote",
      name,
      url: `${EMOTE_CDN}/${span.id}/default/dark/2.0`,
      provider: "twitch",
    });
    cursor = span.end + 1;
  }
  if (cursor < chars.length) {
    const value = chars.slice(cursor).join("");
    if (value) out.push({ type: "text", value });
  }
  return out;
}
