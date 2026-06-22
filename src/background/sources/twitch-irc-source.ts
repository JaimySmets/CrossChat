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

export class TwitchIrcSource implements ChatSource {
  readonly platform = "twitch" as const;

  private ws: WebSocket | null = null;
  private channel: ResolvedChannel | null = null;
  private intentionalClose = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

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
    this.ws?.close();
    this.ws = null;
    this.stateCb({ status: "disconnected" });
  }

  private open(): void {
    if (!this.channel) return;
    this.stateCb(this.attempt === 0 ? { status: "connecting" } : { status: "reconnecting", attempt: this.attempt });

    const ws = new WebSocket(IRC_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      const nick = `justinfan${Math.floor(Math.random() * 90000) + 10000}`;
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${this.channel!.login}`);
      this.attempt = 0;
      this.backoff = 1000;
      this.stateCb({ status: "connected" });
    });

    ws.addEventListener("message", (ev) => {
      for (const line of String(ev.data).split("\r\n")) {
        if (line) this.handleLine(line);
      }
    });

    ws.addEventListener("close", () => this.scheduleReconnect());
    ws.addEventListener("error", () => ws.close());
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.attempt += 1;
    this.stateCb({ status: "reconnecting", attempt: this.attempt });
    const delay = Math.min(this.backoff, MAX_BACKOFF_MS);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
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
