// Emote Registry (ARCHITECTURE.md §5) — the differentiator. Builds a merged
// name -> emote lookup per channel from 7TV/BTTV/FFZ global + per-channel sets.
// Twitch natives are NOT here; the source already split those out.
import type { EmoteProvider, ResolvedChannel } from "../../shared/types";
import type { RegistryEmote } from "./types";
import { fetchSeventvGlobal, fetchSeventvChannel } from "./seventv";
import { fetchBttvGlobal, fetchBttvChannel } from "./bttv";
import { fetchFfzGlobal } from "./ffz";

/** Provider precedence on name collision (configurable, default 7TV > BTTV > FFZ). */
const PROVIDER_RANK: Record<EmoteProvider, number> = { "7tv": 3, bttv: 2, ffz: 1, twitch: 0 };

const GLOBAL_TTL_MS = 6 * 60 * 60 * 1000; // hours — shared across channels (§5)
const CHANNEL_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  emotes: RegistryEmote[];
  ts: number;
}

let globalCache: CacheEntry | null = null;
const channelCache = new Map<string, CacheEntry>();

const fresh = (e: CacheEntry | null | undefined, ttl: number): boolean =>
  !!e && Date.now() - e.ts < ttl;

async function getGlobals(): Promise<RegistryEmote[]> {
  if (fresh(globalCache, GLOBAL_TTL_MS)) return globalCache!.emotes;
  const [stv, bttv, ffz] = await Promise.all([
    fetchSeventvGlobal(),
    fetchBttvGlobal(),
    fetchFfzGlobal(),
  ]);
  const emotes = [...stv, ...bttv, ...ffz];
  globalCache = { emotes, ts: Date.now() };
  return emotes;
}

async function getChannelEmotes(
  userId: string,
  ffzChannelEmotes: RegistryEmote[],
): Promise<RegistryEmote[]> {
  if (!userId) return ffzChannelEmotes;
  const cached = channelCache.get(userId);
  if (fresh(cached, CHANNEL_TTL_MS)) return cached!.emotes;
  const [stv, bttv] = await Promise.all([
    fetchSeventvChannel(userId),
    fetchBttvChannel(userId),
  ]);
  const emotes = [...stv, ...bttv, ...ffzChannelEmotes];
  channelCache.set(userId, { emotes, ts: Date.now() });
  return emotes;
}

export interface EmoteHit {
  url: string;
  provider: EmoteProvider;
}

export class EmoteRegistry {
  private map = new Map<string, { hit: EmoteHit; score: number }>();

  add(emotes: RegistryEmote[]): void {
    for (const e of emotes) {
      const score = (e.channel ? 10 : 0) + PROVIDER_RANK[e.provider];
      const existing = this.map.get(e.name);
      if (!existing || score > existing.score) {
        this.map.set(e.name, { hit: { url: e.url, provider: e.provider }, score });
      }
    }
  }

  lookup(name: string): EmoteHit | undefined {
    return this.map.get(name)?.hit;
  }

  get size(): number {
    return this.map.size;
  }
}

/** Build the merged registry for a channel (globals cached, channel sets cached by id). */
export async function buildRegistry(
  channel: ResolvedChannel,
  ffzChannelEmotes: RegistryEmote[],
): Promise<EmoteRegistry> {
  const [globals, channelEmotes] = await Promise.all([
    getGlobals(),
    getChannelEmotes(channel.userId, ffzChannelEmotes),
  ]);
  const registry = new EmoteRegistry();
  registry.add(globals); // globals first; channel sets overwrite on higher score
  registry.add(channelEmotes);
  return registry;
}
