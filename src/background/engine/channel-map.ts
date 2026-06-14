// YouTube handle -> Twitch login mapping, persisted in chrome.storage.local
// (ARCHITECTURE.md §7). Storage + prompt only for MVP (no shared GitHub JSON).
const PREFIX = "map:";

export async function getMapping(youtubeHandle: string): Promise<string | null> {
  const key = PREFIX + youtubeHandle;
  const out = await chrome.storage.local.get(key);
  const login = out[key];
  return typeof login === "string" && login ? login : null;
}

export async function setMapping(youtubeHandle: string, twitchLogin: string): Promise<void> {
  await chrome.storage.local.set({ [PREFIX + youtubeHandle]: twitchLogin.toLowerCase() });
}
