import type { EmoteProvider } from "../../shared/types";

/** A third-party emote resolved by a provider fetcher, before merge. */
export interface RegistryEmote {
  name: string;
  url: string;
  provider: EmoteProvider; // "7tv" | "bttv" | "ffz" (twitch natives come from the source)
  /** Channel-specific emotes win over global on name collision (§5). */
  channel: boolean;
}
