// Emote Registry (ARCHITECTURE.md §5) — the differentiator. Builds a merged
// name -> emote lookup per channel from 7TV/BTTV/FFZ global + per-channel sets.
// Twitch natives are NOT here; the source already split those out.
//
// Emotes are held in layers (globals + one per channel provider) so the live
// watcher (`watcher.ts`) can swap or patch one provider's channel set and the
// merged map is recomputed from scratch — a removed emote must hand its name
// back to whichever lower-ranked emote it was shadowing.
import type { EmoteProvider, ResolvedChannel } from "../../shared/types";
import type { RegistryEmote } from "./types";
import { fetchSeventvGlobal, fetchSeventvChannel, type SeventvChannel } from "./seventv";
import { fetchBttvGlobal, fetchBttvChannel } from "./bttv";
import { fetchFfzGlobal } from "./ffz";

/** Provider precedence on name collision (configurable, default 7TV > BTTV > FFZ). */
const PROVIDER_RANK: Record<EmoteProvider, number> = { "7tv": 3, bttv: 2, ffz: 1, twitch: 0 };

const GLOBAL_TTL_MS = 6 * 60 * 60 * 1000; // hours — shared across channels (§5)
const CHANNEL_TTL_MS = 30 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  ts: number;
}

let globalCache: CacheEntry<RegistryEmote[]> | null = null;
const stvCache = new Map<string, CacheEntry<SeventvChannel>>();
const bttvCache = new Map<string, CacheEntry<RegistryEmote[]>>();

const fresh = <T>(e: CacheEntry<T> | null | undefined, ttl: number): boolean =>
  !!e && Date.now() - e.ts < ttl;

async function getGlobals(): Promise<RegistryEmote[]> {
  if (globalCache && fresh(globalCache, GLOBAL_TTL_MS)) return globalCache.value;
  const [stv, bttv, ffz] = await Promise.all([
    fetchSeventvGlobal(),
    fetchBttvGlobal(),
    fetchFfzGlobal(),
  ]);
  const emotes = [...stv, ...bttv, ...ffz];
  // Providers fail soft (return []), so an all-empty result means every one of
  // them fell over, not that there are no global emotes. Don't cache that — it
  // would poison the registry for the full TTL. Serve stale if we have it and
  // retry on the next build. (Mirrors the badge registry.)
  if (emotes.length === 0) return globalCache?.value ?? [];
  globalCache = { value: emotes, ts: Date.now() };
  return emotes;
}

/**
 * Fetch-through cache for one channel provider. A failed fetch (null) is not
 * cached: serve stale if there is any, else empty, and retry on the next build.
 */
async function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  userId: string,
  fetcher: (userId: string) => Promise<T | null>,
  empty: T,
): Promise<T> {
  const hit = cache.get(userId);
  if (hit && fresh(hit, CHANNEL_TTL_MS)) return hit.value;
  const value = await fetcher(userId);
  if (value === null) return hit?.value ?? empty;
  cache.set(userId, { value, ts: Date.now() });
  return value;
}

/**
 * Drop a channel's cached sets. The watcher calls this on every live change so
 * a later panel attach refetches rather than reviving the pre-change set.
 */
export function invalidateChannelCache(userId: string): void {
  stvCache.delete(userId);
  bttvCache.delete(userId);
}

/** Identity of one emote within a layer: the same emote id can appear under two names. */
export const emoteKey = (e: RegistryEmote): string => `${e.id}\n${e.name}`;

export interface EmoteHit {
  url: string;
  provider: EmoteProvider;
}

/** `global` holds all three providers' globals; the rest are channel sets. */
export type EmoteLayer = "global" | "7tv" | "bttv" | "ffz";

export class EmoteRegistry {
  // Insertion order is the tie-break on equal score (first wins), so globals
  // must be set first; re-setting a layer keeps its original position.
  private layers = new Map<EmoteLayer, RegistryEmote[]>();
  private map = new Map<string, { hit: EmoteHit; score: number }>();

  /**
   * Replace one layer wholesale (initial build, refetch after reconnect/poll).
   * Exact duplicates (same id and name) are dropped: 7TV sets can list the same
   * emote twice, which would otherwise break id-based removal and diffing.
   */
  setLayer(layer: EmoteLayer, emotes: RegistryEmote[]): void {
    const seen = new Set<string>();
    this.layers.set(
      layer,
      emotes.filter((e) => {
        const key = emoteKey(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    this.rebuild();
  }

  getLayer(layer: EmoteLayer): readonly RegistryEmote[] {
    return this.layers.get(layer) ?? [];
  }

  /** Add an emote to a layer. Returns false if that exact emote is already there. */
  add(layer: EmoteLayer, emote: RegistryEmote): boolean {
    const list = this.layers.get(layer) ?? [];
    if (list.some((e) => emoteKey(e) === emoteKey(emote))) return false;
    this.setLayer(layer, [...list, emote]);
    return true;
  }

  /**
   * Remove one emote from a layer by id, and by name too when given (a 7TV set
   * can hold one emote under several names). Returns it, or undefined if absent.
   */
  remove(layer: EmoteLayer, id: string, name?: string): RegistryEmote | undefined {
    const list = this.layers.get(layer) ?? [];
    const index = list.findIndex((e) => e.id === id && (name === undefined || e.name === name));
    if (index < 0) return undefined;
    const removed = list[index];
    this.setLayer(layer, list.filter((_, i) => i !== index));
    return removed;
  }

  private rebuild(): void {
    this.map.clear();
    for (const emotes of this.layers.values()) {
      for (const e of emotes) {
        const score = (e.channel ? 10 : 0) + PROVIDER_RANK[e.provider];
        const existing = this.map.get(e.name);
        if (!existing || score > existing.score) {
          this.map.set(e.name, { hit: { url: e.url, provider: e.provider }, score });
        }
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

export interface BuiltRegistry {
  registry: EmoteRegistry;
  /** 7TV ids the watcher subscribes to (both null if the channel has no 7TV). */
  stvSetId: string | null;
  stvUserId: string | null;
}

/** Build the merged registry for a channel (globals cached, channel sets cached by id). */
export async function buildRegistry(
  channel: ResolvedChannel,
  ffzChannelEmotes: RegistryEmote[],
): Promise<BuiltRegistry> {
  const noStv: SeventvChannel = { emotes: [], setId: null, stvUserId: null };
  const [globals, stv, bttv] = await Promise.all([
    getGlobals(),
    channel.userId ? cached(stvCache, channel.userId, fetchSeventvChannel, noStv) : noStv,
    channel.userId ? cached(bttvCache, channel.userId, fetchBttvChannel, []) : [],
  ]);
  const registry = new EmoteRegistry();
  registry.setLayer("global", globals); // first: channel layers win on higher score
  registry.setLayer("7tv", stv.emotes);
  registry.setLayer("bttv", bttv);
  registry.setLayer("ffz", ffzChannelEmotes);
  return { registry, stvSetId: stv.setId, stvUserId: stv.stvUserId };
}
