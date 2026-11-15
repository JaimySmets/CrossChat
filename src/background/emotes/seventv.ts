// 7TV provider (ARCHITECTURE.md §5). Global set + per-channel set keyed by the
// Twitch user id. Emote image: <host.url>/<file>, host.url is protocol-relative.
import type { RegistryEmote } from "./types";

const API = "https://7tv.io/v3";

interface StvFile { name: string }
/** An active emote as it appears in an emote set (REST) or an EventAPI change. */
export interface StvEmote {
  id?: string;
  name: string;
  data?: { host?: { url?: string; files?: StvFile[] } };
}

/** Channel set plus the ids the EventAPI subscriptions are keyed by. */
export interface SeventvChannel {
  emotes: RegistryEmote[];
  /** Active emote set id (`emote_set.update` subscription), null if none. */
  setId: string | null;
  /** 7TV user id (`user.update` subscription, catches active-set switches). */
  stvUserId: string | null;
}

function urlFor(emote: StvEmote): string {
  const host = emote.data?.host;
  if (!host?.url) return "";
  const files = host.files ?? [];
  const pick =
    files.find((f) => f.name === "2x.webp") ??
    files.find((f) => f.name.startsWith("2x")) ??
    files[files.length - 1];
  const file = pick?.name ?? "2x.webp";
  const base = host.url.startsWith("//") ? `https:${host.url}` : host.url;
  return `${base}/${file}`;
}

/** Map one 7TV emote; null when it lacks an id, name or image host. */
export function toSeventvEmote(e: StvEmote, channel: boolean): RegistryEmote | null {
  const url = urlFor(e);
  if (!url || !e.id || !e.name) return null;
  return { id: e.id, name: e.name, url, provider: "7tv", channel };
}

function toEmotes(emotes: StvEmote[] | undefined, channel: boolean): RegistryEmote[] {
  const out: RegistryEmote[] = [];
  for (const e of emotes ?? []) {
    const emote = toSeventvEmote(e, channel);
    if (emote) out.push(emote);
  }
  return out;
}

export async function fetchSeventvGlobal(): Promise<RegistryEmote[]> {
  try {
    const res = await fetch(`${API}/emote-sets/global`);
    if (!res.ok) return [];
    const data = (await res.json()) as { emotes?: StvEmote[] };
    return toEmotes(data.emotes, false);
  } catch {
    return [];
  }
}

/**
 * The channel's active 7TV set. A 404 means the channel has no 7TV account,
 * which is a real (empty) answer; null means the request failed and callers
 * should keep whatever they already have.
 */
export async function fetchSeventvChannel(userId: string): Promise<SeventvChannel | null> {
  if (!userId) return { emotes: [], setId: null, stvUserId: null };
  try {
    const res = await fetch(`${API}/users/twitch/${userId}`, { cache: "no-store" });
    if (res.status === 404) return { emotes: [], setId: null, stvUserId: null };
    if (!res.ok) return null;
    const data = (await res.json()) as {
      emote_set_id?: string | null;
      emote_set?: { id?: string; emotes?: StvEmote[] } | null;
      user?: { id?: string };
    };
    return {
      emotes: toEmotes(data.emote_set?.emotes, true),
      setId: data.emote_set?.id ?? data.emote_set_id ?? null,
      stvUserId: data.user?.id ?? null,
    };
  } catch {
    return null;
  }
}
