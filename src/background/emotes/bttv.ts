// BetterTTV provider (ARCHITECTURE.md §5). Global set + per-channel set
// (channelEmotes + sharedEmotes) keyed by the Twitch user id.
import type { RegistryEmote } from "./types";

const API = "https://api.betterttv.net/3";
const CDN = "https://cdn.betterttv.net/emote";

interface BttvEmote {
  id: string;
  code: string;
}

function toEmotes(emotes: BttvEmote[] | undefined, channel: boolean): RegistryEmote[] {
  const out: RegistryEmote[] = [];
  for (const e of emotes ?? []) {
    if (e.id && e.code) out.push({ name: e.code, url: `${CDN}/${e.id}/2x`, provider: "bttv", channel });
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

export async function fetchBttvChannel(userId: string): Promise<RegistryEmote[]> {
  if (!userId) return [];
  try {
    const res = await fetch(`${API}/cached/users/twitch/${userId}`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      channelEmotes?: BttvEmote[];
      sharedEmotes?: BttvEmote[];
    };
    return [...toEmotes(data.channelEmotes, true), ...toEmotes(data.sharedEmotes, true)];
  } catch {
    return [];
  }
}
