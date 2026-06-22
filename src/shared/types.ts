// Core platform-agnostic contracts (ARCHITECTURE.md §4).
// Every source normalizes into these shapes; rendering and emote compositing
// operate only on NormalizedMessage, never on platform-specific payloads.

export type Platform = "twitch" | "kick" | "youtube";
export type EmoteProvider = "twitch" | "7tv" | "bttv" | "ffz";

export interface Badge {
  /** Provider/set id, e.g. "moderator", "subscriber". */
  id: string;
  /** Resolved image URL when known; sources may leave this undefined. */
  url?: string;
  /** Human-readable title/tooltip when known. */
  title?: string;
  /** Set version from the wire payload (e.g. Twitch `subscriber/12`); used to resolve artwork. */
  version?: string;
  /** Tenure for cumulative badges (e.g. subscriber months from Twitch `badge-info`). */
  count?: number;
}

export type Fragment =
  | { type: "text"; value: string }
  | { type: "emote"; name: string; url: string; provider: EmoteProvider };

export interface NormalizedMessage {
  id: string;
  author: { displayName: string; color?: string; badges: Badge[] };
  /** Text + platform-native emotes, pre-split by the source. */
  fragments: Fragment[];
  timestamp: number;
  platform: Platform;
}

export interface ResolvedChannel {
  platform: Platform;
  /** e.g. twitch username (lowercased login). */
  login: string;
  /** Numeric/string platform ID — needed for emote sets + EventSub. */
  userId: string;
  displayName?: string;
}

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "reconnecting"; attempt: number }
  | { status: "error"; message: string }
  | { status: "disconnected" };

export interface ChatSource {
  platform: Platform;
  connect(channel: ResolvedChannel): Promise<void>;
  disconnect(): void;
  onMessage(cb: (msg: NormalizedMessage) => void): void;
  onState(cb: (s: ConnectionState) => void): void;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface ChatSink {
  platform: Platform;
  send(channel: ResolvedChannel, text: string): Promise<SendResult>;
  capabilities(): { canSend: boolean; rateLimitHint?: number };
}
