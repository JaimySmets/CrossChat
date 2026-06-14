// FrankerFaceZ provider (ARCHITECTURE.md §5). The room endpoint doubles as our
// no-auth Twitch user-ID resolver: its payload carries `room.twitch_id`, which
// we feed to 7TV and BTTV for their per-channel sets.
import type { RegistryEmote } from "./types";

const API = "https://api.frankerfacez.com/v1";

interface FfzEmote {
  name: string;
  urls: Record<string, string>; // { "1": "//cdn.../1", "2": ..., "4": ... }
}
interface FfzSet {
  emoticons: FfzEmote[];
}
interface FfzRoomResponse {
  room?: { twitch_id?: number; _id?: number };
  sets?: Record<string, FfzSet>;
}
interface FfzGlobalResponse {
  default_sets?: number[];
  sets?: Record<string, FfzSet>;
}

function pickUrl(urls: Record<string, string>): string {
  const raw = urls["4"] ?? urls["2"] ?? urls["1"] ?? Object.values(urls)[0] ?? "";
  return raw.startsWith("//") ? `https:${raw}` : raw;
}

function toEmotes(sets: Record<string, FfzSet> | undefined, channel: boolean): RegistryEmote[] {
  const out: RegistryEmote[] = [];
  for (const set of Object.values(sets ?? {})) {
    for (const e of set.emoticons ?? []) {
      const url = pickUrl(e.urls);
      if (url) out.push({ name: e.name, url, provider: "ffz", channel });
    }
  }
  return out;
}

/** Per-channel FFZ set + the channel's Twitch user id (null if unknown). */
export async function fetchFfzRoom(
  login: string,
): Promise<{ userId: string | null; emotes: RegistryEmote[] }> {
  try {
    const res = await fetch(`${API}/room/${encodeURIComponent(login)}`);
    if (!res.ok) return { userId: null, emotes: [] };
    const data = (await res.json()) as FfzRoomResponse;
    const id = data.room?.twitch_id ?? data.room?._id;
    return {
      userId: id != null ? String(id) : null,
      emotes: toEmotes(data.sets, true),
    };
  } catch {
    return { userId: null, emotes: [] };
  }
}

export async function fetchFfzGlobal(): Promise<RegistryEmote[]> {
  try {
    const res = await fetch(`${API}/set/global`);
    if (!res.ok) return [];
    const data = (await res.json()) as FfzGlobalResponse;
    return toEmotes(data.sets, false);
  } catch {
    return [];
  }
}
