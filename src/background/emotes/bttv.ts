// BetterTTV provider (ARCHITECTURE.md §5). Global set + per-channel set
// (channelEmotes + sharedEmotes) keyed by the Twitch user id.
import type { RegistryEmote } from "./types";

const API = "https://api.betterttv.net/3";
const CDN = "https://cdn.betterttv.net/emote";

/** A BTTV emote as it appears in REST payloads and socket events. */
export interface BttvEmote {
  id: string;
  code: string;
}

/** Map one BTTV emote; null when it lacks an id or code. */
export function toBttvEmote(e: BttvEmote, channel: boolean): RegistryEmote | null {
  if (!e.id || !e.code) return null;
  return { id: e.id, name: e.code, url: `${CDN}/${e.id}/2x`, provider: "bttv", channel };
}

function toEmotes(emotes: BttvEmote[] | undefined, channel: boolean): RegistryEmote[] {
  const out: RegistryEmote[] = [];
  for (const e of emotes ?? []) {
    const emote = toBttvEmote(e, channel);
    if (emote) out.push(emote);
  }
  return out;
}

export async function fetchBttvGlobal(): Promise<RegistryEmote[]> {
  try {
    const res = await fetch(`${API}/cached/emotes/global`);
    if (!res.ok) return [];
    const data = (await res.json()) as BttvEmote[];
    return toEmotes(data, false);
  } catch {
    return [];
  }
}

/**
 * The channel's BTTV emotes. A 404 means the channel has no BTTV account (a
 * real, empty answer); null means the request failed and callers should keep
 * whatever they already have.
 */
export async function fetchBttvChannel(userId: string): Promise<RegistryEmote[] | null> {
  if (!userId) return [];
  try {
    const res = await fetch(`${API}/cached/users/twitch/${userId}`, { cache: "no-store" });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const data = (await res.json()) as {
      channelEmotes?: BttvEmote[];
      sharedEmotes?: BttvEmote[];
    };
    return [...toEmotes(data.channelEmotes, true), ...toEmotes(data.sharedEmotes, true)];
  } catch {
    return null;
  }
}
