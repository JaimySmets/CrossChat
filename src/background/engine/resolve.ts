// Resolve a Twitch login into a ResolvedChannel (ARCHITECTURE.md §4.4, §5).
// User id comes from FFZ's room endpoint — no OAuth/app token needed for MVP.
// The fetched per-channel FFZ emotes are returned too so the registry can reuse
// them without a second request.
import type { ResolvedChannel } from "../../shared/types";
import type { RegistryEmote } from "../emotes/types";
import { fetchFfzRoom } from "../emotes/ffz";

export interface ResolvedTwitch {
  channel: ResolvedChannel;
  ffzChannelEmotes: RegistryEmote[];
}

export async function resolveTwitchChannel(login: string): Promise<ResolvedTwitch> {
  const normalized = login.toLowerCase();
  const { userId, emotes } = await fetchFfzRoom(normalized);
  return {
    channel: {
      platform: "twitch",
      login: normalized,
      userId: userId ?? "", // empty if FFZ had no record; IRC read still works
      displayName: login,
    },
    ffzChannelEmotes: emotes,
  };
}
