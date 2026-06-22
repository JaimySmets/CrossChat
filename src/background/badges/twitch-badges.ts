// Twitch badge registry — resolves IRC badge codes (`setID/version`) to real
// badge artwork + titles, mirroring the Emote Registry's shape and caching.
//
// Strategy is layered and swappable behind one seam (`getUserToken`):
//   • user token present → Helix (official, free; needs only the user token) — future
//   • otherwise          → anonymous GraphQL (no auth, undocumented) — primary today
//   • lookup miss / fetch failure → caller falls back to CSS role chips (render.ts)
//
// No client secret is ever involved. Per ARCHITECTURE.md / CLAUDE.md, the gql
// path is a no-auth spike: undocumented and churn-prone, but isolated here so a
// failure degrades gracefully rather than breaking chat.
import type { NormalizedMessage, ResolvedChannel } from "../../shared/types";

const GQL = "https://gql.twitch.tv/gql";
/** Twitch's public web Client-Id — a public identifier, not a secret. */
const PUBLIC_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const GLOBAL_TTL_MS = 6 * 60 * 60 * 1000; // shared across channels (like globals in §5)
const CHANNEL_TTL_MS = 30 * 60 * 1000;

export interface ResolvedBadge {
  url: string;
  title: string;
}

/** Merged global + per-channel badge lookup, keyed by `setID/version`. */
export class BadgeRegistry {
  constructor(private readonly map: Map<string, ResolvedBadge>) {}
  lookup(setId: string, version: string): ResolvedBadge | undefined {
    return this.map.get(`${setId}/${version}`);
  }
}

interface GqlBadge {
  setID: string;
  version: string;
  title: string;
  imageURL: string;
}

interface CacheEntry {
  badges: GqlBadge[];
  ts: number;
}

let globalCache: CacheEntry | null = null;
const channelCache = new Map<string, CacheEntry>();

const fresh = (e: CacheEntry | null | undefined, ttl: number): boolean =>
  !!e && Date.now() - e.ts < ttl;

/**
 * Returns a Twitch user OAuth token once the (future) auth flow has one, else
 * null. Today there is no auth, so badges come from the no-auth gql path; when
 * OAuth lands this is the only function that changes — engine/render stay put.
 */
function getUserToken(): string | null {
  return null;
}

export async function buildBadgeRegistry(channel: ResolvedChannel): Promise<BadgeRegistry> {
  // Reserved for the official upgrade: `if (getUserToken()) return fromHelix(...)`.
  void getUserToken();

  const [global, perChannel] = await Promise.all([
    getGlobalBadges(),
    getChannelBadges(channel),
  ]);

  // Global first, channel overrides — channel sub tiers/custom badges win, the
  // same precedence the emote registry uses for channel vs global sets.
  const map = new Map<string, ResolvedBadge>();
  for (const b of global) put(map, b);
  for (const b of perChannel) put(map, b);
  return new BadgeRegistry(map);
}

/** Fill in `url`/`title` on any badge we can resolve; untouched badges fall back to chips. */
export function applyBadges(msg: NormalizedMessage, registry: BadgeRegistry): NormalizedMessage {
  let changed = false;
  const badges = msg.author.badges.map((b) => {
    if (b.url || !b.version) return b; // already resolved, or no version to match on
    const hit = registry.lookup(b.id, b.version);
    if (!hit) return b;
    changed = true;
    return { ...b, url: hit.url, title: b.title ?? hit.title };
  });
  if (!changed) return msg;
  return { ...msg, author: { ...msg.author, badges } };
}

function put(map: Map<string, ResolvedBadge>, b: GqlBadge): void {
  if (!b?.setID || !b.imageURL) return;
  map.set(`${b.setID}/${b.version}`, { url: b.imageURL, title: b.title || b.setID });
}

async function getGlobalBadges(): Promise<GqlBadge[]> {
  if (fresh(globalCache, GLOBAL_TTL_MS)) return globalCache!.badges;
  try {
    const badges = await fetchBadges(null);
    globalCache = { badges, ts: Date.now() };
    return badges;
  } catch {
    return globalCache?.badges ?? []; // serve stale if we have it, else nothing
  }
}

async function getChannelBadges(channel: ResolvedChannel): Promise<GqlBadge[]> {
  const key = channel.userId || channel.login;
  const cached = channelCache.get(key);
  if (fresh(cached, CHANNEL_TTL_MS)) return cached!.badges;
  try {
    const badges = await fetchBadges(channel.login);
    channelCache.set(key, { badges, ts: Date.now() });
    return badges;
  } catch {
    return cached?.badges ?? [];
  }
}

/** One anonymous gql request: global set (login null) or a channel's broadcast badges. */
async function fetchBadges(login: string | null): Promise<GqlBadge[]> {
  const query = login
    ? `query{user(login:${JSON.stringify(login)}){broadcastBadges{setID version title imageURL}}}`
    : `query{badges{setID version title imageURL}}`;
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Client-Id": PUBLIC_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`gql badges ${res.status}`);
  const data = (await res.json()) as {
    data?: { badges?: GqlBadge[]; user?: { broadcastBadges?: GqlBadge[] | null } | null };
  };
  return (login ? data.data?.user?.broadcastBadges : data.data?.badges) ?? [];
}
