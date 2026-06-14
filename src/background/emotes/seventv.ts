// 7TV provider (ARCHITECTURE.md §5). Global set + per-channel set keyed by the
// Twitch user id. Emote image: <host.url>/<file>, host.url is protocol-relative.
import type { RegistryEmote } from "./types";

const API = "https://7tv.io/v3";

interface StvFile { name: string }
interface StvEmote {
  name: string;
  data?: { host?: { url?: string; files?: StvFile[] } };
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

function toEmotes(emotes: StvEmote[] | undefined, channel: boolean): RegistryEmote[] {
  const out: RegistryEmote[] = [];
  for (const e of emotes ?? []) {
    const url = urlFor(e);
    if (url) out.push({ name: e.name, url, provider: "7tv", channel });
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

export async function fetchSeventvChannel(userId: string): Promise<RegistryEmote[]> {
  if (!userId) return [];
  try {
    const res = await fetch(`${API}/users/twitch/${userId}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { emote_set?: { emotes?: StvEmote[] } };
    return toEmotes(data.emote_set?.emotes, true);
  } catch {
    return [];
  }
}
